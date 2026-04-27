/**
 * Fastify request authentication.
 *
 * preHandler that loads the session from the akk_session cookie and
 * attaches the user to request. Routes that need auth pass requireAuth;
 * routes that want optional auth pass loadUser.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../db/schema.js';
import { SESSION_COOKIE, loadSession } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export async function loadUser(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  const session = await loadSession(token);
  if (session) request.user = session.user;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await loadUser(request);
  if (!request.user) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
