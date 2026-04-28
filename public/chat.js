(() => {
  // ─────────────────────────────────────────────────────────────
  // /chat — vanilla JS chat client.
  //
  // Loads message history on mount, lets the user submit a message,
  // POSTs to /api/chat/send, renders the assistant reply. Auto-scrolls,
  // auto-grows the input, handles Enter to send / Shift+Enter for newline,
  // and falls back to /start on 401 (session expired or never logged in).
  // ─────────────────────────────────────────────────────────────

  const threadEl = document.getElementById('chat-thread');
  const emptyEl = document.getElementById('chat-empty');
  const emptyTitle = document.getElementById('chat-empty-title');
  const typingEl = document.getElementById('chat-typing');
  const formEl = document.getElementById('chat-form');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const mainEl = document.querySelector('.chat-main');

  let me = null;
  let sending = false;

  // ─────────────────────────────────────────────────────────────
  // Safe HTML rendering for assistant bubbles.
  //
  // The agent emits HTML formatted for Telegram (<b>, <code>, <a>, <i>,
  // <br>). User-provided strings are escapeHtml'd server-side before
  // being interpolated, so the HTML on the wire is "safe" by contract.
  // We belt-and-brace it client-side: parse the string, walk the DOM,
  // unwrap any tag not on the whitelist, strip non-allowed attributes.
  // ─────────────────────────────────────────────────────────────
  const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'CODE', 'PRE', 'BR', 'A']);
  const ALLOWED_ATTRS = { A: new Set(['href']) };

  function safeRenderInto(targetEl, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    sanitize(tpl.content);
    // Anchor sanitization: open in new tab + rel hardening.
    tpl.content.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    targetEl.replaceChildren(tpl.content);
  }

  function sanitize(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (!ALLOWED_TAGS.has(tag)) {
          // Replace with its text content rather than dropping silently.
          const text = document.createTextNode(child.textContent ?? '');
          child.parentNode.replaceChild(text, child);
        } else {
          const allowed = ALLOWED_ATTRS[tag] ?? new Set();
          [...child.attributes].forEach((attr) => {
            if (!allowed.has(attr.name)) {
              child.removeAttribute(attr.name);
              return;
            }
            // Defang non-http(s) hrefs; allow our own deep links.
            if (attr.name === 'href') {
              const v = attr.value.trim();
              if (!/^https?:\/\//i.test(v) && !v.startsWith('/')) {
                child.removeAttribute('href');
              }
            }
          });
          sanitize(child);
        }
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.parentNode.removeChild(child);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Time formatting — drop seconds, use locale-aware HH:MM.
  // ─────────────────────────────────────────────────────────────
  function formatTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DOM nodes for one message.
  // ─────────────────────────────────────────────────────────────
  function renderMessage(msg) {
    if (msg.role === 'system') return null; // never shown
    const li = document.createElement('li');
    li.className = `chat-msg from-${msg.role}`;
    li.dataset.id = msg.id;

    const inner = document.createElement('div');
    inner.className = 'chat-bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (msg.role === 'assistant') {
      safeRenderInto(bubble, msg.content);
    } else {
      bubble.textContent = msg.content;
    }
    inner.appendChild(bubble);

    if (msg.createdAt) {
      const t = document.createElement('div');
      t.className = 'chat-time';
      t.textContent = formatTime(msg.createdAt);
      inner.appendChild(t);
    }

    li.appendChild(inner);
    return li;
  }

  function appendMessage(msg) {
    const node = renderMessage(msg);
    if (!node) return;
    threadEl.appendChild(node);
    emptyEl.hidden = true;
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      mainEl.scrollTop = mainEl.scrollHeight;
    });
  }

  function showTyping(visible) {
    typingEl.hidden = !visible;
    if (visible) scrollToBottom();
  }

  // ─────────────────────────────────────────────────────────────
  // API helpers.
  // ─────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      window.location.href = '/start';
      throw new Error('unauthorized');
    }
    return res;
  }

  async function loadMe() {
    const res = await api('/api/me');
    me = await res.json();
    const first = (me?.name ?? '').trim().split(/\s+/)[0];
    if (emptyTitle && first) {
      emptyTitle.textContent = `Hi ${first} — what should we cook?`;
    }
  }

  async function loadHistory() {
    const res = await api('/api/chat/messages?limit=50');
    const data = await res.json();
    const list = data.messages ?? [];
    if (list.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    list.forEach((m) => {
      const node = renderMessage(m);
      if (node) threadEl.appendChild(node);
    });
    scrollToBottom();
  }

  // ─────────────────────────────────────────────────────────────
  // Send flow.
  // ─────────────────────────────────────────────────────────────
  async function send(text) {
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;

    // Optimistic: render the user's message immediately.
    const localMsg = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    appendMessage(localMsg);

    inputEl.value = '';
    autoresize();
    showTyping(true);

    try {
      const res = await api('/api/chat/send', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        appendMessage({
          id: 'err-' + Date.now(),
          role: 'assistant',
          content:
            data.error === 'agent_failed'
              ? "Something broke on my end. Try again in a minute 🙏"
              : "Couldn't send that message.",
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const data = await res.json();
      (data.replies ?? []).forEach((m) => appendMessage(m));
    } catch (err) {
      appendMessage({
        id: 'err-' + Date.now(),
        role: 'assistant',
        content: "Network blip — try once more.",
        createdAt: new Date().toISOString(),
      });
    } finally {
      showTyping(false);
      sending = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Composer behaviour: auto-grow textarea + Enter to send.
  // ─────────────────────────────────────────────────────────────
  function autoresize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }

  inputEl.addEventListener('input', autoresize);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send(inputEl.value.trim());
  });

  document.querySelectorAll('.chip.suggest').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.prefill ?? btn.textContent ?? '';
      send(text.trim());
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Boot.
  // ─────────────────────────────────────────────────────────────
  (async () => {
    try {
      await loadMe();
      await loadHistory();
      inputEl.focus();
    } catch (err) {
      // 401 handler in api() already redirected; otherwise log.
      // eslint-disable-next-line no-console
      console.error(err);
    }
  })();
})();
