import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agentTasks, type AgentTask } from '../db/schema.js';

const ACTIVE_STATUSES = ['active', 'waiting_user'] as const;
const ZEPTO_ORDER_TTL_MS = 30 * 60 * 1000;

export interface ZeptoSearchState {
  kind: 'zepto_order';
  phase: 'awaiting_selection_or_confirmation' | 'cart_staged' | 'checkout_attempted';
  searchTool?: string;
  searchArgs?: unknown;
  searchResult?: string;
  cartResult?: string;
  checkoutResult?: string;
  lastUserMessage?: string;
  selectedOptionNumber?: number;
  finalConfirmationRequested?: boolean;
  updatedReason?: string;
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
  const existing = await getActiveZeptoOrderTask(args.userId);
  const state: ZeptoSearchState = {
    kind: 'zepto_order',
    phase: 'awaiting_selection_or_confirmation',
    searchTool: args.searchTool,
    searchArgs: args.searchArgs,
    searchResult: args.searchResult,
    updatedReason: 'zepto_search',
  };

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

export async function updateZeptoOrderTaskState(args: {
  userId: string;
  patch: Partial<ZeptoSearchState>;
  status?: 'active' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
}): Promise<void> {
  const existing = await getActiveZeptoOrderTask(args.userId);
  if (!existing) return;

  await db
    .update(agentTasks)
    .set({
      status: args.status ?? existing.status,
      state: {
        ...existing.state,
        ...args.patch,
      },
      expiresAt:
        args.status === 'completed' || args.status === 'cancelled' || args.status === 'failed'
          ? existing.expiresAt
          : zeptoOrderExpiresAt(),
      updatedAt: new Date(),
    })
    .where(eq(agentTasks.id, existing.id));
}

export async function cancelActiveZeptoOrderTask(userId: string): Promise<boolean> {
  const existing = await getActiveZeptoOrderTask(userId);
  if (!existing) return false;
  await db
    .update(agentTasks)
    .set({
      status: 'cancelled',
      state: { ...existing.state, updatedReason: 'user_cancelled' },
      updatedAt: new Date(),
    })
    .where(eq(agentTasks.id, existing.id));
  return true;
}
