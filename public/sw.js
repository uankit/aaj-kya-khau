/* eslint-env serviceworker */
/* global self, clients */

// Aaj Kya Khaun service worker.
//
// Today: handles install/activate (passes through fetches — no offline
// caching yet), receives Web Push events, opens /chat on notification
// click. Tomorrow: cache the chat shell + last-N messages for offline.

const VERSION = 'akk-sw-v1';

self.addEventListener('install', (event) => {
  // Take over immediately on first install / version bump.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Claim already-open pages so the new SW controls them without a reload.
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch for now. Adding a cache layer later is purely additive.
self.addEventListener('fetch', () => {});

// ─────────────────────────────────────────────────────────────
// Push: server sends a JSON payload { title, body, url, tag? }
// We render a notification; clicking it focuses or opens the URL.
// ─────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Aaj Kya Khaun', body: event.data?.text() ?? '' };
  }

  const title = payload.title || 'Aaj Kya Khaun';
  const options = {
    body: payload.body || '',
    icon: '/static/icon.svg',
    badge: '/static/icon.svg',
    tag: payload.tag || 'akk-default',
    data: { url: payload.url || '/chat' },
    // Renotify only when the tag is a fresh kind of nudge.
    renotify: !!payload.renotify,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/chat';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Focus an already-open chat tab if we have one.
      for (const c of all) {
        try {
          const cUrl = new URL(c.url);
          if (cUrl.pathname === '/chat') {
            await c.focus();
            return;
          }
        } catch {
          /* skip */
        }
      }
      // Otherwise open a new one.
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
