/**
 * /api/push/* — Web Push subscription management.
 *
 * GET    /api/push/vapid-key       — public key for the browser's
 *                                    PushManager.subscribe call. Public,
 *                                    no auth (it's the public half of an
 *                                    asymmetric keypair).
 * POST   /api/me/push/subscribe    — store the browser's subscription
 *                                    so we can send notifications to it.
 *                                    Auth required.
 * POST   /api/me/push/unsubscribe  — remove a subscription by endpoint.
 *                                    Auth required.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../config/database.js';
import { webPushSubscriptions } from '../db/schema.js';
import { getPublicKey, pushAvailable } from '../surfaces/webpush/adapter.js';
import { createLogger } from '../utils/logger.js';
import { requireAuth } from './auth-middleware.js';

const log = createLogger('web-push-api');

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  // Public — the public VAPID key is safe to expose. Returns null when
  // VAPID isn't configured so the frontend can fall back gracefully.
  app.get('/api/push/vapid-key', async (_request, reply) => {
    return reply.send({
      configured: pushAvailable(),
      publicKey: getPublicKey(),
    });
  });

  app.post('/api/me/push/subscribe', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const u = request.user!;
    const ua = (request.headers['user-agent'] ?? '').toString().slice(0, 200);

    // Upsert by endpoint — same browser re-subscribing must not duplicate.
    const existing = await db
      .select({ id: webPushSubscriptions.id })
      .from(webPushSubscriptions)
      .where(eq(webPushSubscriptions.endpoint, parsed.data.endpoint))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(webPushSubscriptions)
        .set({
          userId: u.id,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          userAgent: ua,
          lastSeenAt: new Date(),
        })
        .where(eq(webPushSubscriptions.id, existing[0]!.id));
    } else {
      await db.insert(webPushSubscriptions).values({
        userId: u.id,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: ua,
      });
    }

    log.info(`push subscribed for user=${u.id}`);
    return reply.send({ ok: true });
  });

  app.post('/api/me/push/unsubscribe', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const u = request.user!;
    await db
      .delete(webPushSubscriptions)
      .where(
        and(
          eq(webPushSubscriptions.userId, u.id),
          eq(webPushSubscriptions.endpoint, parsed.data.endpoint),
        ),
      );
    log.info(`push unsubscribed for user=${u.id}`);
    return reply.send({ ok: true });
  });
}
