(() => {
  const form = document.getElementById('email-form');
  const errorEl = document.getElementById('email-error');
  const emailCard = document.getElementById('email-card');
  const sentCard = document.getElementById('sent-card');
  const sentEmail = document.getElementById('sent-email');
  const resendLink = document.getElementById('resend-link');

  let lastEmail = '';

  async function sendLink(email) {
    errorEl.hidden = true;
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errorEl.textContent = data.error === 'invalid email'
        ? 'That email looks off. Try again.'
        : 'Something went wrong. Try again in a minute.';
      errorEl.hidden = false;
      return false;
    }
    return true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim();
    if (!email) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const ok = await sendLink(email);
    btn.disabled = false;
    if (ok) {
      lastEmail = email;
      sentEmail.textContent = email;
      emailCard.hidden = true;
      sentCard.hidden = false;
    }
  });

  resendLink?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!lastEmail) return;
    resendLink.textContent = 'sending...';
    const ok = await sendLink(lastEmail);
    resendLink.textContent = ok ? 'sent ✓' : 'try again';
    setTimeout(() => (resendLink.textContent = 'resend'), 3000);
  });
})();
