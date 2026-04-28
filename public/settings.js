(() => {
  // ─────────────────────────────────────────────────────────────
  // /settings — vanilla JS.
  //
  // Loads /api/me on mount, hydrates each section, wires up the four
  // edit flows (profile / schedule / connections / account). All saves
  // are PATCH-style; destructive actions (disconnect Zepto, delete
  // account) require explicit confirmation.
  // ─────────────────────────────────────────────────────────────

  const loadingEl = document.getElementById('settings-loading');
  const sections = ['profile', 'schedule', 'connections', 'account'].map((s) =>
    document.getElementById(`section-${s}`),
  );

  let me = null;

  // ─────────────────────────────────────────────────────────────
  // API helper — same shape as /chat. Redirects to /start on 401.
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

  // ─────────────────────────────────────────────────────────────
  // Inline "Saved ✓" pill — shows for 2s then fades out.
  // ─────────────────────────────────────────────────────────────
  function flashToast(id) {
    const t = document.getElementById(id);
    if (!t) return;
    t.hidden = false;
    setTimeout(() => (t.hidden = true), 2000);
  }

  // ─────────────────────────────────────────────────────────────
  // Boot — load + hydrate.
  // ─────────────────────────────────────────────────────────────
  async function boot() {
    const res = await api('/api/me');
    me = await res.json();
    hydrateProfile();
    hydrateSchedule();
    hydrateConnections();
    hydrateAccount();
    loadingEl.hidden = true;
    sections.forEach((s) => (s.hidden = false));
  }

  // ─────────────────────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────────────────────
  function hydrateProfile() {
    document.getElementById('f-name').value = me.name ?? '';
    document.getElementById('f-timezone').value = me.timezone ?? 'Asia/Kolkata';
    if (me.dietType) {
      const radio = document.querySelector(
        `#section-profile input[name="dietType"][value="${me.dietType}"]`,
      );
      if (radio) radio.checked = true;
    }
  }

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: String(fd.get('name') || '').trim(),
      dietType: fd.get('dietType') ? String(fd.get('dietType')) : undefined,
      timezone: String(fd.get('timezone') || '').trim() || undefined,
    };
    const res = await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) return alert('Could not save profile.');
    me = { ...me, ...body };
    flashToast('toast-profile');
  });

  // ─────────────────────────────────────────────────────────────
  // Schedule — values prefilled from /api/me/schedule (we'll fetch
  // on demand because /api/me doesn't include schedule rows).
  // For simplicity, we just set defaults; users see the values
  // they last saved next time they visit (server is source of truth).
  // ─────────────────────────────────────────────────────────────
  const DEFAULT_TIMES = {
    breakfast: '08:00',
    lunch: '13:00',
    snack: '17:00',
    dinner: '20:30',
    nightly: '22:00',
  };

  function hydrateSchedule() {
    Object.keys(DEFAULT_TIMES).forEach((k) => {
      const input = document.querySelector(`#schedule-form [name="${k}"]`);
      if (input && !input.value) input.value = DEFAULT_TIMES[k];
    });
    const nightly = me.nightlySummaryAt;
    if (nightly) {
      const hhmm = String(nightly).slice(0, 5);
      const el = document.querySelector('#schedule-form [name="nightly"]');
      if (el) el.value = hhmm;
    }
  }

  function buildScheduleBody(useDefaults) {
    const f = document.getElementById('schedule-form');
    const fd = new FormData(f);
    if (useDefaults) return { useDefaults: true };
    const meals = ['breakfast', 'lunch', 'snack', 'dinner']
      .map((mealType) => {
        const v = String(fd.get(mealType) || '').trim();
        return v ? { mealType, remindAt: v, enabled: true } : null;
      })
      .filter(Boolean);
    return {
      meals,
      nightlySummaryAt: String(fd.get('nightly') || '22:00'),
    };
  }

  document.getElementById('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/me/schedule', {
      method: 'PATCH',
      body: JSON.stringify(buildScheduleBody(false)),
    });
    if (!res.ok) return alert('Could not save schedule.');
    flashToast('toast-schedule');
  });

  document.getElementById('schedule-defaults').addEventListener('click', async () => {
    Object.entries(DEFAULT_TIMES).forEach(([k, v]) => {
      const el = document.querySelector(`#schedule-form [name="${k}"]`);
      if (el) el.value = v;
    });
    const res = await api('/api/me/schedule', {
      method: 'PATCH',
      body: JSON.stringify(buildScheduleBody(true)),
    });
    if (!res.ok) return alert('Could not reset schedule.');
    flashToast('toast-schedule');
  });

  // ─────────────────────────────────────────────────────────────
  // Connections
  // ─────────────────────────────────────────────────────────────
  function hydrateConnections() {
    const zStatus = document.getElementById('zepto-status');
    const zBtn = document.getElementById('btn-zepto');
    if (me.zeptoConnected) {
      zStatus.textContent = 'Connected';
      zStatus.classList.add('is-connected');
      zBtn.textContent = 'Disconnect';
    } else {
      zStatus.textContent = 'Not connected';
      zStatus.classList.add('is-disconnected');
      zBtn.textContent = 'Connect';
    }

    const tStatus = document.getElementById('telegram-status');
    if (me.telegramConnected) {
      tStatus.textContent = 'Linked to your Telegram';
      tStatus.classList.add('is-connected');
    } else {
      tStatus.textContent = 'Not linked';
      tStatus.classList.add('is-disconnected');
    }

  }

  document.getElementById('btn-zepto').addEventListener('click', async () => {
    if (me.zeptoConnected) {
      if (!confirm('Disconnect Zepto? You can reconnect anytime.')) return;
      const res = await api('/api/me/zepto', { method: 'DELETE' });
      if (!res.ok) return alert('Could not disconnect.');
      me.zeptoConnected = false;
      hydrateConnections();
    } else {
      // Send them back to /app to redo the OAuth paste flow.
      window.location.href = '/app';
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Account
  // ─────────────────────────────────────────────────────────────
  function hydrateAccount() {
    document.getElementById('acct-email').textContent = me.email ?? '(no email)';
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // Delete-account modal flow
  const modal = document.getElementById('delete-modal');
  const confirmInput = document.getElementById('delete-confirm');
  const confirmBtn = document.getElementById('btn-delete-confirm');

  document.getElementById('btn-delete-open').addEventListener('click', () => {
    confirmInput.value = '';
    confirmBtn.disabled = true;
    modal.hidden = false;
    setTimeout(() => confirmInput.focus(), 50);
  });
  document.getElementById('btn-delete-cancel').addEventListener('click', () => {
    modal.hidden = true;
  });
  modal.addEventListener('click', (e) => {
    // Click outside the card → close.
    if (e.target === modal) modal.hidden = true;
  });
  confirmInput.addEventListener('input', () => {
    confirmBtn.disabled = confirmInput.value.trim() !== 'DELETE';
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    const res = await api('/api/me', { method: 'DELETE' });
    if (!res.ok) {
      alert('Could not delete account. Email hello@aajkyakhaun.com if this persists.');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete forever';
      return;
    }
    window.location.href = '/';
  });

  boot().catch((err) => {
    // 401 already redirected; else log.
    // eslint-disable-next-line no-console
    console.error(err);
  });
})();
