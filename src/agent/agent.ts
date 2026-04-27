/**
 * The agent turn handler.
 *
 * Every post-onboarding interaction — incoming Telegram message, scheduled
 * meal nudge, or nightly summary trigger — funnels through `handleTurn`.
 *
 * Flow:
 *   1. Persist the incoming user message (if any)
 *   2. If there's a PDF attached, parse it FIRST (deterministic, not via LLM
 *      tool call) so the inventory is updated before the LLM sees the turn
 *   3. Load context fresh from the DB
 *   4. Build system prompt + messages array
 *   5. Call generateText() with tools — Vercel AI SDK handles the tool loop
 *   6. Persist the assistant reply
 *   7. Send via Telegram
 */

import { generateText, type CoreMessage } from 'ai';
import { db } from '../config/database.js';
import { messages } from '../db/schema.js';
import { model } from '../llm/client.js';
import { sendHtml } from '../surfaces/telegram/index.js';
import { parseAndSaveInvoice } from '../domain/orders/invoice.js';
import { hasZeptoConnected } from '../providers/grocery/zepto/account.js';
import { loadContext } from './context.js';
import { buildSystemPrompt, type TurnTrigger } from './system-prompt.js';
import { buildTools } from './tools.js';
import { classifyIntent, type Intent } from './intent.js';
import { runOrderTurn } from '../domain/orders/order-workflow.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agent');

// The LLM handles cook / pantry / track / config / chitchat intents via
// the static tools in tools.ts. Zepto ordering is OWNED by the workflow
// in src/domain/orders/order-workflow.ts — the LLM never calls zepto_* tools.
// 3-4 steps is plenty for the non-ordering cases; 5 leaves headroom.
const MAX_TOOL_STEPS = 5;
// LLM hard ceiling. GPT-4o usually answers in <5s; anything over 30s is hung.
// Hitting this limit aborts the request at the HTTP client level and we fall
// back to a friendly error reply rather than letting the user hang forever.
const LLM_TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRY_DELAY_MS = 8_000;
const userTurnLocks = new Map<string, Promise<void>>();

export type AgentTrigger =
  | {
      type: 'message';
      text: string;
      mediaItems: Array<{ fileId: string; contentType: string; fileName?: string }>;
    }
  | { type: 'nudge'; mealType: 'breakfast' | 'lunch' | 'snack' | 'dinner' }
  | { type: 'nightly' };

export async function handleTurn(userId: string, trigger: AgentTrigger): Promise<void> {
  const previous = userTurnLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  userTurnLocks.set(userId, chained);

  await previous.catch(() => {});
  try {
    await handleTurnUnlocked(userId, trigger);
  } finally {
    release();
    if (userTurnLocks.get(userId) === chained) {
      userTurnLocks.delete(userId);
    }
  }
}

async function handleTurnUnlocked(userId: string, trigger: AgentTrigger): Promise<void> {
  try {
    // ── 1. Persist the raw user message (for message-type triggers) ────────
    if (trigger.type === 'message') {
      const text = trigger.text.trim();
      const pdfNote =
        trigger.mediaItems.find((m) => m.contentType === 'application/pdf') !== undefined
          ? ' [sent a PDF invoice]'
          : '';
      const content = text.length > 0 || pdfNote ? `${text}${pdfNote}` : '(empty message)';
      await db.insert(messages).values({ userId, role: 'user', content });
    }

    // ── 2. If a PDF was attached, parse it BEFORE calling the LLM ──────────
    let pdfSummary: string | null = null;
    if (trigger.type === 'message') {
      const pdf = trigger.mediaItems.find((m) => m.contentType === 'application/pdf');
      if (pdf) {
        try {
          const result = await parseAndSaveInvoice({ userId, fileId: pdf.fileId });
          if (result.itemCount === 0) {
            pdfSummary =
              '(PDF processed but no recognizable grocery items were found. Tell the user that gently.)';
          } else {
            const preview = result.items
              .slice(0, 15)
              .map((it) => it.normalizedName)
              .join(', ');
            const more = result.items.length > 15 ? `, +${result.items.length - 15} more` : '';
            pdfSummary = `(PDF processed successfully. ${result.itemCount} items added to inventory: ${preview}${more}. Thank the user and mention a few of them.)`;
          }
        } catch (err) {
          log.error('PDF parse failed inside agent turn', err);
          pdfSummary =
            "(PDF processing failed. Apologize and ask the user to try sending it again, or type out a few items manually.)";
        }
      }
    }

    // ── 3. Load context fresh (inventory will already reflect the PDF) ────
    const ctx = await loadContext(userId);

    // ── 3a. Classify intent for message turns ────────────────────────────
    // Drives which tools / prompt sections fire, and whether we dispatch
    // to the Zepto workflow instead of the LLM.
    let intent: Intent | undefined;
    let orderQuery: string | undefined;
    if (trigger.type === 'message') {
      const classified = await classifyIntent(trigger.text, ctx.history);
      intent = classified.intent;
      orderQuery = classified.orderQuery;
      log.info(`turn intent=${intent} user=${userId}`, orderQuery ? { orderQuery } : undefined);
    }

    // ── 3b. Order intent → deterministic workflow ────────────────────────
    // Zepto ordering no longer goes through the LLM tool loop. The workflow
    // owns address ensurance, search, selection, confirmation, update_cart,
    // and create_order — all with structured state persisted in agent_tasks.
    if (trigger.type === 'message' && intent === 'order') {
      if (!(await hasZeptoConnected(userId))) {
        await sendAndPersist(
          userId,
          "Zepto isn't connected yet. Run <b>/connect_zepto</b> first so I can place orders for you 🛒",
        );
        return;
      }
      const reply = await runOrderTurn({
        userId,
        message: trigger.text,
        orderQuery,
      });
      await sendAndPersist(userId, reply.text);
      return;
    }

    // Only relevant for cook/pantry turns — cheap indexed lookup.
    const zeptoConnected = intent === 'cook' || intent === 'pantry'
      ? await hasZeptoConnected(userId)
      : false;

    // ── 4. Build system prompt + messages ──────────────────────────────────
    const llmTrigger: TurnTrigger =
      trigger.type === 'message'
        ? { type: 'message', text: trigger.text, hasPdf: pdfSummary !== null }
        : trigger;

    const system = buildSystemPrompt(ctx, llmTrigger, {
      intent,
      zeptoConnected,
    });

    const historyMessages: CoreMessage[] = ctx.history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // For non-message triggers (cron-fired nudges / nightly) we need to
    // synthesize a user-role turn so the model has something to respond to.
    // The AI SDK requires at least one user message when tools are enabled.
    let finalMessages: CoreMessage[] = historyMessages;

    if (trigger.type === 'nudge') {
      finalMessages = [
        ...historyMessages,
        {
          role: 'user',
          content: `(system event: scheduled ${trigger.mealType} reminder — generate the nudge message)`,
        },
      ];
    } else if (trigger.type === 'nightly') {
      finalMessages = [
        ...historyMessages,
        {
          role: 'user',
          content:
            '(system event: end-of-day check-in — generate the nightly summary and ask about finished items)',
        },
      ];
    } else if (pdfSummary !== null) {
      // Append the pdf parse result as an additional system note at the end
      // of history so the model sees it right before composing a reply.
      finalMessages = [
        ...historyMessages,
        { role: 'system', content: `PDF processing result: ${pdfSummary}` },
      ];
    }

    // Safety: if history is empty AND this is a normal message turn with no
    // prior history, make sure we at least pass the current user message.
    if (
      finalMessages.length === 0 &&
      trigger.type === 'message' &&
      trigger.text.trim().length > 0
    ) {
      finalMessages = [{ role: 'user', content: trigger.text }];
    }

    // ── 5. Call LLM with tools ─────────────────────────────────────────────
    // Tool set is intent-gated: non-order turns don't load Zepto tools at
    // all (saves ~2k tokens + one MCP round-trip).
    const tools = await buildTools(userId, intent);

    const result = await generateWithRateLimitRetry({
      model,
      system,
      messages: finalMessages,
      tools,
      maxSteps: MAX_TOOL_STEPS,
      temperature: 0.7,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const replyText = (result.text ?? '').trim();

    if (replyText.length === 0) {
      log.warn(`Empty LLM response for user ${userId}; falling back.`);
      const fallback = "Hmm, I didn't quite catch that. Could you try rephrasing?";
      await sendAndPersist(userId, fallback);
      return;
    }

    // ── 6 + 7. Persist + send ─────────────────────────────────────────────
    await sendAndPersist(userId, replyText);
    log.debug(`Agent turn complete for ${userId}`, {
      toolCalls: result.toolCalls?.length ?? 0,
      steps: result.steps?.length ?? 0,
    });
  } catch (err) {
    log.error(`Agent turn failed for user ${userId}`, err);
    // Distinguish timeouts from other errors so the user gets a message
    // that matches reality. AbortError fires when AbortSignal.timeout()
    // trips.
    const isTimeout =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError' || /timeout/i.test(err.message));
    const isRateLimit = isTokenRateLimit(err);
    const fallback = isRateLimit
      ? "OpenAI rate limit hit right as I was placing that. Give me 10 seconds and tap confirm once more 🙏"
      : isTimeout
        ? 'Taking longer than usual. Mind trying that again in a minute?'
        : 'Something went sideways on my end. Give me a minute and try again 🙏';
    // Best-effort fallback so the user doesn't see silence. We use
    // sendAndPersist so the fallback is also recorded in message history —
    // keeps user+assistant messages paired so the next turn's context
    // doesn't show an orphan user message without a reply.
    try {
      await sendAndPersist(userId, fallback);
    } catch (sendErr) {
      // If Telegram is ALSO down, at least the error is logged. The user
      // will see silence but there's nothing we can do about it from here.
      log.error(`Fallback send also failed for user ${userId}`, sendErr);
    }
  }
}

type GenerateTextArgs = Parameters<typeof generateText>[0];

async function generateWithRateLimitRetry(args: GenerateTextArgs) {
  try {
    return await generateText(args);
  } catch (err) {
    if (!isTokenRateLimit(err)) throw err;
    log.warn(`OpenAI token rate limit hit; retrying once after ${RATE_LIMIT_RETRY_DELAY_MS}ms`);
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    return generateText({
      ...args,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  }
}

function isTokenRateLimit(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (current instanceof Error) {
      if (/rate limit|tokens per min|rate_limit_exceeded/i.test(current.message)) return true;
    }

    if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (
        obj.statusCode === 429 &&
        /rate limit|tokens per min|rate_limit_exceeded/i.test(
          `${String(obj.message ?? '')} ${String(obj.responseBody ?? '')}`,
        )
      ) {
        return true;
      }
      for (const key of ['cause', 'lastError', 'errors']) {
        const value = obj[key];
        if (Array.isArray(value)) stack.push(...value);
        else if (value) stack.push(value);
      }
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a message AND persist it to history.
 *
 * Order matters: send first, persist second. If sending fails, the user
 * never sees the message, so we don't want it in history pretending they did.
 * If persistence fails after a successful send, we log but don't throw —
 * the user already got their reply and retrying would double-send. The
 * history will have a one-turn gap which is much better than a double text.
 */
async function sendAndPersist(userId: string, text: string): Promise<void> {
  const telegramId = await telegramIdForUserId(userId);
  if (!telegramId) {
    log.warn(`Cannot send — user ${userId} has no telegram_id`);
    return;
  }
  await sendHtml(telegramId, text);
  try {
    await db.insert(messages).values({ userId, role: 'assistant', content: text });
  } catch (persistErr) {
    log.error(
      `Message sent to ${telegramId} but DB persist failed — history will have a gap`,
      persistErr,
    );
    // Deliberately do NOT rethrow: user already got their reply, and
    // rethrowing would trigger the fallback path which would double-send.
  }
}

async function telegramIdForUserId(userId: string): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.id, userId),
    columns: { telegramId: true },
  });
  return user?.telegramId ?? null;
}
