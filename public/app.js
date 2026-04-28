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

  // ── Zepto ──────────────────────────────────────────────
  const zeptoNotConnected = document.getElementById('zepto-not-connected');
  const zeptoConnected = document.getElementById('zepto-connected');
  const zeptoOpenBtn = document.getElementById('zepto-open');
  const zeptoConnectBtn = document.getElementById('zepto-connect');
  const zeptoCodeInput = document.getElementById('zepto-code');
  const zeptoErr = document.getElementById('zepto-error');

  zeptoOpenBtn.addEventListener('click', async () => {
    zeptoOpenBtn.disabled = true;
    zeptoOpenBtn.textContent = 'opening…';
    const res = await api('/api/oauth/zepto/start', { method: 'POST' });
    zeptoOpenBtn.disabled = false;
    zeptoOpenBtn.textContent = 'Open Zepto auth ↗';
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      zeptoErr.textContent = data.error === 'zepto_not_configured'
        ? 'Zepto OAuth client is not configured on the server.'
        : 'Could not start Zepto auth. Try again.';
      zeptoErr.hidden = false;
      return;
    }
    const { authUrl } = await res.json();
    window.open(authUrl, '_blank', 'noopener,noreferrer');
  });

  zeptoConnectBtn.addEventListener('click', async () => {
    zeptoErr.hidden = true;
    const raw = zeptoCodeInput.value.trim();
    // Accept either a bare code or the full Postman callback URL —
    // pluck the code= param if a URL was pasted.
    const m = raw.match(/[?&]code=([^&\s]+)/);
    const code = m ? decodeURIComponent(m[1]) : raw;
    if (!code) {
      zeptoErr.textContent = 'Paste the code or the whole callback URL.';
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
        no_pending_oauth_or_expired: 'That auth window expired. Click "Open Zepto auth" again.',
        exchange_failed: 'Code rejected. Make sure you copied the whole code.',
        verify_failed:
          "Code accepted but Zepto didn't recognise the session. Try the auth flow again.",
        zepto_not_configured: 'Zepto OAuth client is not configured on the server.',
      };
      zeptoErr.textContent = map[data.error] ?? 'Could not connect Zepto. Try again.';
      zeptoErr.hidden = false;
      return;
    }
    const data = await res.json().catch(() => ({}));
    const name = data.profile?.name?.trim();
    const titleEl = document.getElementById('zepto-connected-title');
    if (titleEl) {
      titleEl.textContent = name
        ? `Connected as ${name}.`
        : 'Zepto is connected.';
    }
    me.zeptoConnected = true;
    zeptoNotConnected.hidden = true;
    zeptoConnected.hidden = false;
  });

  document.getElementById('zepto-continue').addEventListener('click', () => show('surface'));

  // ── Surface (Telegram only) ────────────────────────────
  const bindLinkEl = document.getElementById('bind-link');
  let surfaceLoaded = false;
  async function loadSurfaceStep() {
    if (surfaceLoaded) return;
    surfaceLoaded = true;
    const res = await api('/api/me/bind/start', { method: 'POST' });
    if (!res.ok) {
      alert('Could not generate the Telegram link. Refresh and try again.');
      return;
    }
    const { deepLink } = await res.json();
    bindLinkEl.href = deepLink;
    document.getElementById('done-link').href = deepLink;
    document.getElementById('done-surface').textContent = 'Telegram';
    const firstName = (me?.name ?? '').trim().split(/\s+/)[0];
    const titleEl = document.getElementById('done-title');
    if (titleEl) {
      titleEl.textContent = firstName
        ? `You're all set, ${firstName}.`
        : "You're all set.";
    }
  }
  bindLinkEl.addEventListener('click', async () => {
    // The user is leaving for Telegram. Mark onboarding complete optimistically;
    // the actual verify happens when they send /start <token>.
    await api('/api/me/onboarding/complete', { method: 'POST' });
    setTimeout(() => show('done'), 1200);
  });

  // ── Boot ───────────────────────────────────────────────
  loadMe();
})();
