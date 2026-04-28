/**
 * Web Push surface — sends VAPID-signed push notifications to subscribed
 * browsers. Used by the scheduler / nightly cron to nudge web users at
 * meal times.
 *
 * Subscriptions are stored in web_push_subscriptions (one row per
 * device); send loops over them, parallel-fires, and prunes any that
 * the push service reports as gone (HTTP 404 / 410).
 *
 * If VAPID keys aren't configured, this is a logging no-op so the rest
 * of the app stays functional without notifications.
 */

import { eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import { db } from '../../config/database.js';
import { webPushSubscriptions } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('surface-webpush');

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where notificationclick should land. Defaults to /chat. */
  url?: string;
  /** Push tag — same tag replaces previous notification rather than stacking. */
  tag?: string;
  /** Force a re-notify when the same tag is reused. */
  renotify?: boolean;
}

export interface SendResult {
  attempted: number;
  delivered: number;
  pruned: number;
}

/**
 * Send a push to every subscription registered for a user. Endpoints the
 * push service rejects as gone are deleted in the same call.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<SendResult> {
  if (!ensureConfigured()) {
    log.info(`[no-vapid] would push to user=${userId}`, payload);
    return { attempted: 0, delivered: 0, pruned: 0 };
  }

  const subs = await db
    .select()
    .from(webPushSubscriptions)
    .where(eq(webPushSubscriptions.userId, userId));

  if (subs.length === 0) {
    return { attempted: 0, delivered: 0, pruned: 0 };
  }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/chat',
    tag: payload.tag,
    renotify: payload.renotify ?? false,
  });

  const goneIds: string[] = [];
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
        delivered++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          // Subscription is dead. Prune.
          goneIds.push(sub.id);
        } else {
          log.warn(`push failed for user=${userId} endpoint=${sub.endpoint.slice(-12)}`, err);
        }
      }
    }),
  );

  if (goneIds.length > 0) {
    await db
      .delete(webPushSubscriptions)
      .where(inArray(webPushSubscriptions.id, goneIds));
    log.info(`pruned ${goneIds.length} stale push subs for user=${userId}`);
  }

  return { attempted: subs.length, delivered, pruned: goneIds.length };
}

/** Whether VAPID is configured on this server. Useful for /api/push/vapid-key. */
export function pushAvailable(): boolean {
  return ensureConfigured();
}

export function getPublicKey(): string | null {
  return env.VAPID_PUBLIC_KEY ?? null;
}
