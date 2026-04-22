/**
 * Durable state for multi-turn agent flows.
 *
 * Only use case today: after a successful zepto_search, stash the summarized
 * result in agent_tasks so the LLM can see it again on the next turn when
 * the user replies "yes" / "the second one". Without this, the search
 * result only lives in the transient Vercel-AI-SDK tool loop and the next
 * turn's LLM wouldn't know which product IDs to pass to add_to_cart.
 *
 * The LLM owns the full ordering flow — search, add-to-cart, checkout —
 * via its registered zepto_* tools. This module is just a memory aid.
 */

import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agentTasks, type AgentTask } from '../db/schema.js';

const ACTIVE_STATUSES = ['active', 'waiting_user'] as const;
const ZEPTO_ORDER_TTL_MS = 30 * 60 * 1000;

export interface ZeptoSearchState {
  kind: 'zepto_order';
  searchTool: string;
  searchArgs?: unknown;
  /** Filtered top-N summary with product IDs — what the LLM saw as tool result. */
  searchResult: string;
  lastSearchedAt: string;
}

export type ZeptoOrderTask = AgentTask & { state: ZeptoSearchState };

function zeptoOrderExpiresAt(): Date {
  return new Date(Date.now() + ZEPTO_ORDER_TTL_MS);
}

function isZeptoOrderState(state: unknown): state is ZeptoSearchState {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { kind?: unknown }).kind === 'zepto_order'
  );
}

export async function getActiveZeptoOrderTask(userId: string): Promise<ZeptoOrderTask | null> {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.userId, userId),
        eq(agentTasks.type, 'zepto_order'),
        inArray(agentTasks.status, [...ACTIVE_STATUSES]),
        gt(agentTasks.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentTasks.updatedAt))
    .limit(1);

  if (!task || !isZeptoOrderState(task.state)) return null;
  return task as ZeptoOrderTask;
}

export async function saveZeptoSearchTask(args: {
  userId: string;
  searchTool: string;
  searchArgs: unknown;
  searchResult: string;
}): Promise<void> {
  const state: ZeptoSearchState = {
    kind: 'zepto_order',
    searchTool: args.searchTool,
    searchArgs: args.searchArgs,
    searchResult: args.searchResult,
    lastSearchedAt: new Date().toISOString(),
  };

  const existing = await getActiveZeptoOrderTask(args.userId);
  if (existing) {
    await db
      .update(agentTasks)
      .set({
        status: 'waiting_user',
        state,
        expiresAt: zeptoOrderExpiresAt(),
        updatedAt: new Date(),
      })
      .where(eq(agentTasks.id, existing.id));
    return;
  }

  await db.insert(agentTasks).values({
    userId: args.userId,
    type: 'zepto_order',
    status: 'waiting_user',
    state,
    expiresAt: zeptoOrderExpiresAt(),
  });
}

/**
 * Mark the active zepto order task as completed. Called after the LLM
 * successfully places the order so we don't inject stale search context
 * into the next unrelated turn.
 */
export async function completeZeptoOrderTask(userId: string): Promise<void> {
  const existing = await getActiveZeptoOrderTask(userId);
  if (!existing) return;
  await db
    .update(agentTasks)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(agentTasks.id, existing.id));
}
