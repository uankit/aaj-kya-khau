(() => {
  // ────────────────────────────────────────────────────────
  // Tiny client-side state machine for onboarding.
  //
  // GET /api/me on load → decide which step to render.
  // Each step submits to the relevant API, then advances locally.
  // ────────────────────────────────────────────────────────

  const STEPS = ['profile', 'schedule', 'zepto', 'surface', 'done'];
  const stepEls = Object.fromEntries(
    STEPS.map((s) => [s, document.getElementById(`step-${s}`)]),
  );
  const loadingEl = document.getElementById('step-loading');
  const dotsEl = document.getElementById('step-dots');

  let me = null;

  function show(step) {
    loadingEl.hidden = true;
    STEPS.forEach((s) => (stepEls[s].hidden = s !== step));
    renderDots(step);
    if (step === 'surface') void loadSurfaceStep();
  }

  function renderDots(active) {
    const idx = STEPS.indexOf(active);
    dotsEl.innerHTML = '';
    STEPS.forEach((_, i) => {
      const d = document.createElement('span');
      d.className = 'dot';
      if (i < idx) d.classList.add('is-done');
      if (i === idx) d.classList.add('is-active');
      dotsEl.appendChild(d);
    });
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, { ...opts, headers });
  }

  async function loadMe() {
    const res = await api('/api/me');
    if (res.status === 401) {
      window.location.href = '/start';
      return;
    }
    me = await res.json();
    decideStep();
  }

  function decideStep() {
    if (!me.name) return show('profile');
    // Skip schedule if already set; for v1, treat presence of nightlySummaryAt
    // (always set) as not a signal — instead, schedule is one-shot, never blocking.
    // We always show it once until onboardingComplete is true.
    if (!me.zeptoConnected) return show('zepto');
    if (!me.telegramConnected) return show('surface');
    if (!me.onboardingComplete) return show('done');
    return show('done');
  }

  // ── Profile ────────────────────────────────────────────
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: String(fd.get('name') || '').trim(),
      dietType: fd.get('dietType') ? String(fd.get('dietType')) : undefined,
    };
    if (!body.name) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const res = await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
    btn.disabled = false;
    if (!res.ok) return alert('Could not save your profile. Try again.');
    me = { ...me, ...body };
    show('schedule');
  });

  // ── Schedule ───────────────────────────────────────────
  async function submitSchedule(useDefaults) {
    const f = document.getElementById('schedule-form');
    const fd = new FormData(f);
    const body = useDefaults
      ? { useDefaults: true }
      : {
          meals: [
            { mealType: 'breakfast', remindAt: String(fd.get('breakfast') || '08:00') },
            { mealType: 'lunch',     remindAt: String(fd.get('lunch')     || '13:00') },
            { mealType: 'snack',     remindAt: String(fd.get('snack')     || '17:00') },
            { mealType: 'dinner',    remindAt: String(fd.get('dinner')    || '20:30') },
          ],
          nightlySummaryAt: String(fd.get('nightly') || '22:00'),
        };
    const res = await api('/api/me/schedule', { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) return alert('Could not save schedule. Try again.');
    show('zepto');
  }
  document.getElementById('schedule-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitSchedule(false);
  });
  document.getElementById('schedule-defaults').addEventListener('click', () => submitSchedule(true));

  // ── Zepto (3 stages: auth → paste → success) ───────────
  const zeptoStageAuth = document.getElementById('zepto-stage-auth');
  const zeptoStagePaste = document.getElementById('zepto-stage-paste');
  const zeptoConnected = document.getElementById('zepto-connected');
  const zeptoOpenBtn = document.getElementById('zepto-open');
  const zeptoReopenBtn = document.getElementById('zepto-reopen');
  const zeptoConnectBtn = document.getElementById('zepto-connect');
  const zeptoCodeInput = document.getElementById('zepto-code');
  const zeptoErr = document.getElementById('zepto-error');

  function showZeptoStage(stage) {
    zeptoStageAuth.hidden = stage !== 'auth';
    zeptoStagePaste.hidden = stage !== 'paste';
    zeptoConnected.hidden = stage !== 'success';
  }

  async function startZeptoAuth(triggerBtn) {
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'opening…';
    }
    const res = await api('/api/oauth/zepto/start', { method: 'POST' });
    if (triggerBtn) triggerBtn.disabled = false;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      zeptoErr.textContent = data.error === 'zepto_not_configured'
        ? 'Zepto OAuth is not configured on the server.'
        : 'Could not open Zepto. Try again.';
      zeptoErr.hidden = false;
      if (triggerBtn) triggerBtn.textContent = 'Open Zepto ↗';
      return;
    }
    const { authUrl } = await res.json();
    window.open(authUrl, '_blank', 'noopener,noreferrer');
    if (triggerBtn) triggerBtn.textContent = 'Open Zepto ↗';
    // Move to the paste stage and focus the input so the user can
    // paste straight away.
    showZeptoStage('paste');
    setTimeout(() => zeptoCodeInput.focus(), 80);
  }

  zeptoOpenBtn.addEventListener('click', () => startZeptoAuth(zeptoOpenBtn));
  zeptoReopenBtn.addEventListener('click', () => startZeptoAuth(null));

  zeptoConnectBtn.addEventListener('click', async () => {
    zeptoErr.hidden = true;
    const raw = zeptoCodeInput.value.trim();
    // Accept either a bare code or the full Postman callback URL —
    // pluck the code= param if a URL was pasted.
    const m = raw.match(/[?&]code=([^&\s]+)/);
    const code = m ? decodeURIComponent(m[1]) : raw;
    if (!code) {
      zeptoErr.textContent = 'Paste the URL or code from the Zepto page.';
      zeptoErr.hidden = false;
      return;
    }
    zeptoConnectBtn.disabled = true;
    zeptoConnectBtn.textContent = 'connecting…';
    const res = await api('/api/oauth/zepto/finish', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    zeptoConnectBtn.disabled = false;
    zeptoConnectBtn.textContent = 'Connect Zepto';
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const map = {
        no_pending_oauth_or_expired: 'That window expired — open Zepto again.',
        exchange_failed: "That code didn't work. Copy the whole URL and try once more.",
        verify_failed: "Connection didn't stick. Open Zepto again and re-paste.",
        zepto_not_configured: 'Zepto OAuth is not configured on the server.',
      };
      zeptoErr.textContent = map[data.error] ?? 'Could not connect. Try again.';
      zeptoErr.hidden = false;
      return;
    }
    const data = await res.json().catch(() => ({}));
    const name = data.profile?.name?.trim();
    const titleEl = document.getElementById('zepto-connected-title');
    if (titleEl) {
      titleEl.textContent = name ? `Connected as ${name}.` : 'Zepto is connected.';
    }
    me.zeptoConnected = true;
    showZeptoStage('success');
  });

  document.getElementById('zepto-continue').addEventListener('click', () => show('surface'));

  // ── Surface picker ─────────────────────────────────────
  const bindPromptEl = document.getElementById('bind-prompt');
  const bindLinkEl = document.getElementById('bind-link');
  const surfaceCards = document.querySelectorAll('.surface-card');

  function loadSurfaceStep() {
    // Reset any prior state when re-entering this step.
    bindPromptEl.hidden = true;
    surfaceCards.forEach((c) => c.classList.remove('is-selected'));
  }

  async function pickSurface(surface) {
    surfaceCards.forEach((c) => (c.disabled = true));
    const target = [...surfaceCards].find((c) => c.dataset.surface === surface);
    target?.classList.add('is-selected');

    const res = await api('/api/me/surface', {
      method: 'PATCH',
      body: JSON.stringify({ surface }),
    });
    if (!res.ok) {
      alert('Could not save your choice. Try again.');
      surfaceCards.forEach((c) => (c.disabled = false));
      return;
    }

    if (surface === 'web') {
      // No Telegram bind needed. Mark onboarding complete and head to /chat.
      await api('/api/me/onboarding/complete', { method: 'POST' });
      const firstName = (me?.name ?? '').trim().split(/\s+/)[0];
      const titleEl = document.getElementById('done-title');
      const linkEl = document.getElementById('done-link');
      const surfaceEl = document.getElementById('done-surface');
      if (titleEl) {
        titleEl.textContent = firstName ? `You're all set, ${firstName}.` : "You're all set.";
      }
      if (linkEl) {
        linkEl.href = '/chat';
        linkEl.removeAttribute('target');
        linkEl.textContent = 'Open chat →';
      }
      if (surfaceEl) surfaceEl.textContent = 'the chat';
      show('done');
      return;
    }

    // surface === 'telegram' → mint bind token, surface deep link.
    const bindRes = await api('/api/me/bind/start', { method: 'POST' });
    if (!bindRes.ok) {
      alert('Could not generate the Telegram link. Try again.');
      surfaceCards.forEach((c) => (c.disabled = false));
      return;
    }
    const { deepLink } = await bindRes.json();
    bindLinkEl.href = deepLink;
    bindPromptEl.hidden = false;

    const firstName = (me?.name ?? '').trim().split(/\s+/)[0];
    const titleEl = document.getElementById('done-title');
    const linkEl = document.getElementById('done-link');
    const surfaceEl = document.getElementById('done-surface');
    if (titleEl) {
      titleEl.textContent = firstName ? `You're all set, ${firstName}.` : "You're all set.";
    }
    if (linkEl) {
      linkEl.href = deepLink;
      linkEl.setAttribute('target', '_blank');
      linkEl.textContent = 'Open Telegram';
    }
    if (surfaceEl) surfaceEl.textContent = 'Telegram';
  }

  surfaceCards.forEach((card) => {
    card.addEventListener('click', () => pickSurface(card.dataset.surface));
  });

  // When the user clicks the Telegram deep-link, mark onboarding complete
  // optimistically and advance the UI; the actual verify happens server-side
  // when they send /start <token>.
  bindLinkEl.addEventListener('click', async () => {
    await api('/api/me/onboarding/complete', { method: 'POST' });
    setTimeout(() => show('done'), 1200);
  });

  // ── Boot ───────────────────────────────────────────────
  loadMe();
})();
