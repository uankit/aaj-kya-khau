/* =========================================================
   Aaj Kya Khaun — Landing page JS
   • Email signup forms (hero + final CTA)
   • Subtle scroll reveal + parallax + chat-bubble replay
   ========================================================= */

(function () {
  'use strict';

  // Year auto-update in footer.
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ─────────────────────────────────────────────────────────
  // 1. EMAIL SIGNUP — hero + final CTA share the same handler.
  //    POSTs to /api/auth/magic-link; on success swaps the form
  //    for a "check your inbox" message inline.
  // ─────────────────────────────────────────────────────────
  function bindSignup({ formId, inputId, errorId, sentId, sentEmailId }) {
    const form = document.getElementById(formId);
    const input = document.getElementById(inputId);
    const err = document.getElementById(errorId);
    const sent = document.getElementById(sentId);
    const sentEmail = sentEmailId ? document.getElementById(sentEmailId) : null;
    if (!form || !input || !err || !sent) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const email = input.value.trim();
      if (!email) return;

      const btn = form.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;

      let res;
      try {
        res = await fetch('/api/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      } catch {
        err.textContent = 'Network blip. Try once more.';
        err.hidden = false;
        if (btn) btn.disabled = false;
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        err.textContent =
          data.error === 'invalid email'
            ? "That email looks off. Check the spelling?"
            : "Something went wrong. Try again in a minute.";
        err.hidden = false;
        if (btn) btn.disabled = false;
        return;
      }

      if (sentEmail) sentEmail.textContent = email;
      form.hidden = true;
      sent.hidden = false;
    });
  }

  bindSignup({
    formId: 'hero-signup',
    inputId: 'hero-email',
    errorId: 'hero-error',
    sentId: 'hero-sent',
    sentEmailId: 'hero-sent-email',
  });
  bindSignup({
    formId: 'footer-signup',
    inputId: 'footer-email',
    errorId: 'footer-error',
    sentId: 'footer-sent',
    sentEmailId: 'footer-sent-email',
  });

  // ─────────────────────────────────────────────────────────
  // Motion-sensitive eye-candy. Bail out for users who asked.
  // ─────────────────────────────────────────────────────────
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // 2. Scroll reveal — light touch.
  const revealTargets = document.querySelectorAll(
    '.difference, .flows, .how, .science, .final-cta, .comparison-row, .flow-card, .step, .citation-card, .final-card',
  );
  revealTargets.forEach((el) => el.classList.add('reveal'));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
    );
    revealTargets.forEach((el) => observer.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add('in'));
  }

  // 3. Hero blob parallax — very subtle.
  const blobs = document.querySelectorAll('.blob');
  let latestScrollY = window.scrollY;
  let ticking = false;
  function updateParallax() {
    blobs.forEach((blob, i) => {
      const factor = (i + 1) * 0.05;
      blob.style.transform = `translateY(${latestScrollY * factor}px)`;
    });
    ticking = false;
  }
  window.addEventListener(
    'scroll',
    () => {
      latestScrollY = window.scrollY;
      if (!ticking) {
        window.requestAnimationFrame(updateParallax);
        ticking = true;
      }
    },
    { passive: true },
  );

  // 4. Hero chat carousel — alternate meal suggestion and Zepto order flows.
  const chatPanels = Array.from(document.querySelectorAll('[data-chat-panel]'));
  function replayBubbles(panel) {
    const bubbles = panel.querySelectorAll('.chat-bubble');
    bubbles.forEach((b) => {
      b.style.animation = 'none';
      // trigger reflow
      // eslint-disable-next-line no-unused-expressions
      b.offsetWidth;
      b.style.animation = '';
    });
  }

  if (chatPanels.length > 0) {
    let activePanel = Math.max(0, chatPanels.findIndex((panel) => panel.classList.contains('is-active')));
    let chatTimer = null;

    function showPanel(index) {
      chatPanels[activePanel].classList.remove('is-active');
      activePanel = index;
      chatPanels[activePanel].classList.add('is-active');
      replayBubbles(chatPanels[activePanel]);
    }

    function startChatCarousel() {
      replayBubbles(chatPanels[activePanel]);
      if (chatPanels.length < 2 || chatTimer) return;
      chatTimer = window.setInterval(() => {
        showPanel((activePanel + 1) % chatPanels.length);
      }, 6200);
    }

    const chatStack = document.querySelector('.chat-stack');
    if (chatStack && 'IntersectionObserver' in window) {
      const chatObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              startChatCarousel();
              chatObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.35 },
      );
      chatObserver.observe(chatStack);
    } else {
      startChatCarousel();
    }
  }
})();
