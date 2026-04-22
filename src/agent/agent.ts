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
import { sendHtml, sendText, type TelegramInlineKeyboard } from '../services/telegram.js';
import { parseAndSaveInvoice } from '../services/invoice.js';
import { hasZeptoConnected } from '../services/mcp/zepto-account.js';
import { loadContext } from './context.js';
import { buildSystemPrompt, type TurnTrigger } from './system-prompt.js';
import { buildTools } from './tools.js';
import { classifyIntent, type Intent } from './intent.js';
import { createLogger } from '../utils/logger.js';
import {
  cancelActiveZeptoOrderTask,
  getActiveZeptoOrderTask,
  updateZeptoOrderTaskState,
  type ZeptoOrderTask,
} from '../tasks/agent-task-store.js';
import { parseZeptoOrderReply, type ZeptoOrderReply } from '../tasks/zepto-order/confirmations.js';

const log = createLogger('agent');

// Bumped back up from 3 → 5 after observing empty-response failures on
// checkout turns (add_to_cart → checkout → text = 3 steps with zero margin;
// if the LLM re-searched to resolve an ambiguous product, step 3 became
// another tool call and no final text was generated).
//
// Token cost is bounded now by per-tool-result filtering in zepto-tools.ts
// (search results trimmed to top-3, non-search results capped at 1500 chars),
// so raising the ceiling is safe from a cost perspective.
const MAX_TOOL_STEPS = 5;
// LLM hard ceiling. GPT-4o usually answers in <5s; anything over 30s is hung.
// Hitting this limit aborts the request at the HTTP client level and we fall
// back to a friendly error reply rather than letting the user hang forever.
const LLM_TIMEOUT_MS = 30_000;

export type AgentTrigger =
  | {
      type: 'message';
      text: string;
      mediaItems: Array<{ fileId: string; contentType: string; fileName?: string }>;
    }
  | { type: 'nudge'; mealType: 'breakfast' | 'lunch' | 'snack' | 'dinner' }
  | { type: 'nightly' };

export async function handleTurn(userId: string, trigger: AgentTrigger): Promise<void> {
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

    const activeZeptoOrder =
      trigger.type === 'message' ? await getActiveZeptoOrderTask(userId) : null;
    const activeZeptoReply =
      trigger.type === 'message' && activeZeptoOrder
        ? parseZeptoOrderReply(trigger.text)
        : null;

    if (activeZeptoReply?.kind === 'cancel') {
      await cancelActiveZeptoOrderTask(userId);
      await sendAndPersist(userId, 'Cancelled the Zepto order flow. No order placed 👍');
      return;
    }

    // ── 3a. Classify intent for message turns ────────────────────────────
    // Drives which tools are loaded and which system prompt sections fire.
    // Non-message triggers (nudges/nightly) don't need classification — they
    // have their own fixed prompt path.
    let intent: Intent | undefined;
    if (trigger.type === 'message') {
      if (
        activeZeptoOrder &&
        (activeZeptoReply?.kind === 'confirm' || activeZeptoReply?.kind === 'select')
      ) {
        intent = 'order';
        await updateZeptoOrderTaskState({
          userId,
          patch: {
            lastUserMessage: trigger.text,
            selectedOptionNumber:
              activeZeptoReply.kind === 'select'
                ? activeZeptoReply.selectionNumber
                : activeZeptoOrder.state.selectedOptionNumber,
            updatedReason: activeZeptoReply.kind,
          },
          status: 'active',
        });
      } else {
        intent = await classifyIntent(trigger.text, ctx.history);
      }
      log.info(`turn intent=${intent} user=${userId}`);
    }

    // Only relevant for order turns — we could defer this query but it's a
    // single indexed lookup, cheap.
    const zeptoConnected = intent === 'order' || intent === 'cook' || intent === 'pantry'
      ? await hasZeptoConnected(userId)
      : false;

    // ── 4. Build system prompt + messages ──────────────────────────────────
    const llmTrigger: TurnTrigger =
      trigger.type === 'message'
        ? { type: 'message', text: trigger.text, hasPdf: pdfSummary !== null }
        : trigger;

    const system = buildSystemPrompt(ctx, llmTrigger, { intent, zeptoConnected });

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

    if (
      trigger.type === 'message' &&
      activeZeptoOrder &&
      activeZeptoReply &&
      activeZeptoReply.kind !== 'other'
    ) {
      finalMessages = [
        ...finalMessages,
        {
          role: 'system',
          content: formatActiveZeptoOrderNote(activeZeptoOrder, activeZeptoReply),
        },
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

    const result = await generateText({
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
    const replyKeyboard = await buildReplyKeyboard(userId);
    await sendAndPersist(userId, replyText, { html: true, inlineKeyboard: replyKeyboard });
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
    const fallback = isTimeout
      ? "Taking longer than usual 🐢 Mind trying that again in a minute?"
      : "Something went sideways on my end. Give me a minute and try again 🙏";
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

function formatActiveZeptoOrderNote(task: ZeptoOrderTask, reply: ZeptoOrderReply): string {
  const selectedOption =
    reply.kind === 'select'
      ? reply.selectionNumber
      : task.state.selectedOptionNumber;
  const selection =
    selectedOption
      ? `The selected option is ${selectedOption}.`
      : reply.kind === 'confirm'
        ? 'The user explicitly confirmed they want to proceed.'
        : `The user reply kind is ${reply.kind}.`;

  return `ACTIVE ZEPTO ORDER TASK:
You are resuming a pending Zepto order workflow, not starting fresh. ${selection}
Use the previous Zepto search result below as the source of truth. If the user selected a numbered option, show that selected item + price and ask for final COD confirmation. If the user explicitly confirmed after an item was shown, continue with zepto_add_to_cart and then zepto_checkout. Do not re-search unless the user asked for a different item. If the result lacks a usable identifier, ask the user to pick/search again instead of falling back.

Previous search tool: ${task.state.searchTool ?? '(unknown)'}
Previous search args: ${JSON.stringify(task.state.searchArgs ?? {})}
Previous search result:
${task.state.searchResult ?? '(missing)'}`;
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
async function buildReplyKeyboard(userId: string): Promise<TelegramInlineKeyboard | undefined> {
  const pendingOrder = await getActiveZeptoOrderTask(userId);
  if (!pendingOrder || pendingOrder.state.phase !== 'awaiting_selection_or_confirmation') {
    return undefined;
  }

  return [
    [
      { text: '1', callbackData: 'zepto:select:1' },
      { text: '2', callbackData: 'zepto:select:2' },
      { text: '3', callbackData: 'zepto:select:3' },
    ],
    [
      { text: 'Confirm COD order', callbackData: 'zepto:confirm' },
      { text: 'Cancel', callbackData: 'zepto:cancel' },
    ],
  ];
}

async function sendAndPersist(
  userId: string,
  text: string,
  options: { html?: boolean; inlineKeyboard?: TelegramInlineKeyboard } = {},
): Promise<void> {
  const telegramId = await telegramIdForUserId(userId);
  if (!telegramId) {
    log.warn(`Cannot send — user ${userId} has no telegram_id`);
    return;
  }
  if (options.html) {
    await sendHtml(telegramId, text, { inlineKeyboard: options.inlineKeyboard });
  } else {
    await sendText(telegramId, text, { inlineKeyboard: options.inlineKeyboard });
  }
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
