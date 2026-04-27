/**
 * Auth API — magic-link send + verify + logout.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { sendEmail } from './email.js';
import {
  SESSION_COOKIE,
  consumeMagicLink,
  destroySession,
  issueMagicLink,
  issueSession,
} from './sessions.js';

const log = createLogger('web-auth');

const emailSchema = z.object({
  email: z.string().email(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/magic-link', async (request, reply) => {
    const parsed = emailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid email' });
    }
    const email = parsed.data.email.toLowerCase();
    const token = await issueMagicLink(email);
    const base = env.PUBLIC_BASE_URL ?? `http://${request.headers.host ?? 'localhost:3000'}`;
    const link = `${base}/auth/verify?token=${token}`;

    try {
      await sendEmail({
        to: email,
        subject: 'Sign in to Aaj Kya Khaun',
        html: `<p>Hi,</p>
<p>Click the link below to sign in. It expires in 15 minutes and works once.</p>
<p><a href="${link}">${link}</a></p>
<p>— Aaj Kya Khaun</p>`,
        text: `Sign in: ${link}\n\nExpires in 15 minutes.`,
      });
    } catch (err) {
      log.error('magic-link email send failed', err);
      return reply.code(500).send({ error: 'email_send_failed' });
    }

    return reply.send({ sent: true });
  });

  // GET so it can be clicked from the email body.
  app.get('/auth/verify', async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    if (!token) return reply.code(400).send('missing token');
    try {
      const user = await consumeMagicLink(token);
      const session = await issueSession(user.id);
      reply.setCookie(SESSION_COOKIE, session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        expires: session.expiresAt,
      });
      // Send to /app — onboarding state machine decides which step to render.
      return reply.redirect('/app');
    } catch (err) {
      log.warn('magic-link verify failed', err);
      return reply
        .code(400)
        .type('text/html')
        .send(
          '<p>This sign-in link is invalid or expired.</p><p><a href="/start">Get a new link</a></p>',
        );
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
