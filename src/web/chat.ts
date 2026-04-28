/**
 * /api/chat/* — web-side conversation endpoints for users on the /chat
 * page (preferred_surface === 'web').
 *
 * POST /api/chat/send       — drop a user message, run the agent turn
 *                             synchronously, return the latest assistant
 *                             message.
 * GET  /api/chat/messages   — paginated history (default last 50, oldest
 *                             first). Used on initial page load.
 *
 * Both gated by requireAuth — relies on the existing magic-link session
 * cookie. The agent loop (handleTurn) is identical to the Telegram path;
 * sendAndPersist already routes by users.preferred_surface so for web
 * users it just persists to the messages table, and we read the latest
 * row back.
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../config/database.js';
import { messages, type Message } from '../db/schema.js';
import { handleTurn } from '../agent/agent.js';
import { createLogger } from '../utils/logger.js';
import { requireAuth } from './auth-middleware.js';

const log = createLogger('web-chat');

const sendSchema = z.object({
  message: z.string().min(1).max(4000),
});

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

interface WireMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

function toWire(m: Message): WireMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // Initial history. Returns oldest → newest so the frontend can append
  // to a scrollable list without reversing.
  app.get('/api/chat/messages', { preHandler: requireAuth }, async (request, reply) => {
    const u = request.user!;
    const limit = Math.min(
      HISTORY_MAX,
      Math.max(1, Number((request.query as { limit?: string }).limit ?? HISTORY_DEFAULT)),
    );
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.userId, u.id))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    // We pulled newest-first to honour the limit; flip back chronological.
    const out = rows.reverse().map(toWire);
    return reply.send({ messages: out });
  });

  // Send a message. Sync: blocks until the agent's reply is persisted,
  // then returns it. handleTurn is internally serialized per-user so two
  // concurrent POSTs from the same user queue rather than race.
  app.post('/api/chat/send', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid' });
    }
    const u = request.user!;
    const text = parsed.data.message.trim();

    // Anchor: the highest message id we've seen for this user before the
    // turn fires. After handleTurn completes we'll fetch the assistant
    // message inserted strictly after this anchor.
    const [anchor] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.userId, u.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const anchorTime = anchor?.createdAt ?? new Date(0);

    try {
      await handleTurn(u.id, { type: 'message', text, mediaItems: [] });
    } catch (err) {
      log.error(`handleTurn failed for user=${u.id}`, err);
      return reply.code(500).send({ error: 'agent_failed' });
    }

    // Pull every assistant message that appeared after our anchor. Usually
    // exactly one; the workflow occasionally emits a single combined reply.
    const newMessages = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.userId, u.id),
          eq(messages.role, 'assistant'),
          gt(messages.createdAt, anchorTime),
        ),
      )
      .orderBy(asc(messages.createdAt));

    return reply.send({
      replies: newMessages.map(toWire),
    });
  });
}
