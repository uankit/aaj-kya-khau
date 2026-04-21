/* =========================================================
   Aaj Kya Khaun — Landing page JS
   Scroll reveal + subtle parallax. Keep it lean.
   ========================================================= */

(function () {
  'use strict';

  // Respect reduced motion
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // ----- 1. SCROLL REVEAL -----
  // Add .reveal to sections, observe with IntersectionObserver
  const revealTargets = document.querySelectorAll(
    '.why, .features, .how, .science, .final-cta, .feature-card, .citation-card, .why-card, .step',
  );

  revealTargets.forEach((el) => el.classList.add('reveal'));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
  );

  revealTargets.forEach((el) => observer.observe(el));

  // ----- 2. PARALLAX ON HERO BLOBS -----
  // Very subtle — blobs drift with scroll
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

  // ----- 3. HERO TITLE LAYERED HOVER -----
  // Slight mouse tracking on the hero heading for depth
  const hero = document.querySelector('.hero-title');
  if (hero) {
    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      const x = (e.clientX - rect.left - rect.width / 2) / rect.width;
      const y = (e.clientY - rect.top - rect.height / 2) / rect.height;
      hero.style.transform = `perspective(1000px) rotateY(${x * 2}deg) rotateX(${-y * 2}deg)`;
    });
    hero.addEventListener('mouseleave', () => {
      hero.style.transform = 'perspective(1000px) rotateY(0) rotateX(0)';
    });
  }

  // ----- 4. CHAT BUBBLES RE-PLAY ON IN-VIEW -----
  // Replay the bubble animation when the chat mockup first scrolls into view
  const chatFrame = document.querySelector('.chat-frame');
  if (chatFrame) {
    const chatObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const bubbles = entry.target.querySelectorAll('.chat-bubble');
            bubbles.forEach((b) => {
              b.style.animation = 'none';
              // trigger reflow
              // eslint-disable-next-line no-unused-expressions
              b.offsetWidth;
              b.style.animation = '';
            });
            chatObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.4 },
    );
    chatObserver.observe(chatFrame);
  }
})();
