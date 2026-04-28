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
      // First successful exchange unlocks the push opt-in nudge.
      if ((data.replies ?? []).length > 0) maybeOfferPush();
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
  // Service worker + Web Push.
  //
  // Register the SW on every chat load. After it's ready:
  //   • Skip if the browser has no Push or Notification API.
  //   • Skip if permission is 'denied' (don't keep asking).
  //   • If 'granted' AND no subscription on this device → subscribe + POST.
  //   • If 'default' → wait for the user to opt-in via the soft prompt
  //     (rendered after their first agent reply, see maybeOfferPush).
  // ─────────────────────────────────────────────────────────────
  let swReady = null;

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    swReady = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      // eslint-disable-next-line no-console
      .catch((err) => {
        console.warn('sw register failed', err);
        return null;
      });
  }

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function fetchVapidKey() {
    try {
      const res = await fetch('/api/push/vapid-key');
      const data = await res.json();
      return data.configured ? data.publicKey : null;
    } catch {
      return null;
    }
  }

  /**
   * Sync subscription state. If permission is granted and we don't yet
   * have a PushSubscription on this device, create + ship it. Idempotent.
   */
  async function syncPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!swReady) return;
    const reg = await swReady;
    if (!reg) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const publicKey = await fetchVapidKey();
      if (!publicKey) return; // server not configured
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('push subscribe failed', err);
        return;
      }
    }
    try {
      await api('/api/me/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub.toJSON()),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('push subscribe POST failed', err);
    }
  }

  /**
   * Soft permission prompt — shown once after the user's first successful
   * agent reply (so they understand what they're opting into). Gracefully
   * skipped when permission is already decided.
   */
  let pushOffered = false;
  async function maybeOfferPush() {
    if (pushOffered) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') {
      // Already granted → sync; denied → never bother again.
      if (Notification.permission === 'granted') await syncPushSubscription();
      pushOffered = true;
      return;
    }
    pushOffered = true;
    // Tiny inline banner in the thread, action chip to grant.
    const li = document.createElement('li');
    li.className = 'chat-msg from-assistant';
    li.innerHTML = `
      <div class="chat-bubble-wrap">
        <div class="chat-bubble">
          Want me to ping you at meal times? I'll only nudge you at the times you set.
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="chip suggest" id="push-yes">Turn on nudges</button>
            <button class="chip suggest" id="push-no" style="opacity:0.6;">Not now</button>
          </div>
        </div>
      </div>`;
    threadEl.appendChild(li);
    scrollToBottom();
    document.getElementById('push-yes').addEventListener('click', async () => {
      li.remove();
      const result = await Notification.requestPermission();
      if (result === 'granted') await syncPushSubscription();
    });
    document.getElementById('push-no').addEventListener('click', () => {
      li.remove();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Boot.
  // ─────────────────────────────────────────────────────────────
  (async () => {
    try {
      await loadMe();
      await loadHistory();
      inputEl.focus();
      registerServiceWorker();
      // Already-granted permission? Make sure backend has our subscription.
      if ('Notification' in window && Notification.permission === 'granted') {
        syncPushSubscription();
      }
    } catch (err) {
      // 401 handler in api() already redirected; otherwise log.
      // eslint-disable-next-line no-console
      console.error(err);
    }
  })();
})();
