/**
 * Intent classification for incoming messages.
 *
 * Runs BEFORE the main agent turn. The classified intent drives:
 *   - which tools are loaded (cook/pantry don't get Zepto, order does)
 *   - what context is injected into the system prompt (cook gets full
 *     inventory; order gets just a count; chitchat gets minimal)
 *   - how much the agent is allowed to sprawl (each intent has appropriate
 *     scope)
 *
 * Strategy:
 *   1. LLM classifier for every message, using recent history so short
 *      replies like "yes" resolve correctly based on what the bot just
 *      asked.
 *   2. On LLM failure, default to 'cook' (the richest-context intent; safe
 *      because over-including context is a token waste, not a correctness
 *      bug).
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from '../llm/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('intent');

export type Intent = 'order' | 'cook' | 'pantry' | 'track' | 'config' | 'chitchat';

const INTENT_VALUES = ['order', 'cook', 'pantry', 'track', 'config', 'chitchat'] as const;

const IntentSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  /**
   * When intent is 'order', extract one entry PER DISTINCT PRODUCT the user
   * wants. `query` is the concrete product phrase (no imperatives, brand /
   * pack-size hints kept). `quantity` is how many of that line the user
   * asked for (defaults to 1).
   *
   * If the user is confirming a prior proposal (yes / haan / 1), leave the
   * array empty — we already have the items from the earlier turn.
   *
   * Examples:
   *   "order milk and bread"
   *     → [{query:"milk",quantity:1},{query:"bread",quantity:1}]
   *   "get me 2 grameen kulfis"
   *     → [{query:"grameen kulfi",quantity:2}]
   *   "1L milk, 6 eggs and atta"
   *     → [{query:"1L milk",quantity:1},{query:"eggs",quantity:6},{query:"atta",quantity:1}]
   *   "i'm craving bournville"
   *     → [{query:"bournville",quantity:1}]
   *   "yes" / "1" / "haan"
   *     → []
   */
  orderItems: z
    .array(
      z.object({
        query: z.string().min(1),
        quantity: z.number().int().positive().default(1),
      }),
    )
    .optional(),
});

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const CLASSIFY_TIMEOUT_MS = 8_000;

const CLASSIFY_SYSTEM = `You classify one message from a user to their food / kitchen assistant bot. Pick exactly ONE intent:

- order: user wants to buy / order groceries or ingredients from Zepto, OR is craving / wants a specific store-bought grocery/snack/drink/sweet that may need Zepto (e.g. "I'm craving Bournville", "want chips", "get me coke"). Also classify as "order" if the user is confirming a previous Zepto ordering proposal with yes/confirm/go ahead/haan/chalo.
- cook: user wants a meal suggestion, asks what to eat / cook / make, says they're hungry, asks about recipes. Slash shortcut: /hungry.
- pantry: user is managing their kitchen inventory — adding items, marking things finished, asking what they have. Slash shortcut: /kitchen.
- track: nutrition, calories, protein, macros, weight. Also when user is logging a meal they just ate. Slash shortcuts: /ate, /today, /profile.
- config: user is changing settings — meal reminder times, diet type (going vegan etc.), nightly summary time, muting reminders. Slash shortcut: /schedule.
- chitchat: greetings, thanks, random remarks, clarifications. Anything that doesn't fit the others.

Use the RECENT CONVERSATION to disambiguate short replies ("yes", "haan", "go ahead"). If the assistant was just proposing an order, "yes" → order. If the assistant was just suggesting a meal, "yes" → cook.

When intent is 'order', ALSO populate orderItems — an array of {query, quantity} objects, one per distinct product the user mentioned. Strip imperatives ("order", "buy", "get me", "bring me"). Keep brand / flavour / pack-size hints in query. Pull explicit counts ("2 kulfis", "6 eggs") into quantity; default to 1 when no count is given. If the message is a bare confirmation ("yes", "1", "haan", "chalo"), leave orderItems empty — the items live in the prior turn.`;

function formatHistory(history: HistoryMessage[]): string {
  if (history.length === 0) return '(no prior messages)';
  return history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 240)}`)
    .join('\n');
}

export interface OrderItem {
  query: string;
  quantity: number;
}

export interface IntentResult {
  intent: Intent;
  /** Present only when intent is 'order' and concrete products could be extracted. */
  orderItems?: OrderItem[];
}

/**
 * Classify the user's current message into an intent via the LLM. Uses
 * recent history to disambiguate short replies. Never throws — returns
 * 'cook' on failure.
 */
export async function classifyIntent(
  currentMessage: string,
  history: HistoryMessage[] = [],
): Promise<IntentResult> {
  const text = currentMessage.trim();
  if (text.length === 0) return { intent: 'chitchat' };

  try {
    const { object } = await generateObject({
      model,
      schema: IntentSchema,
      system: CLASSIFY_SYSTEM,
      prompt: `RECENT CONVERSATION:\n${formatHistory(history)}\n\nCURRENT MESSAGE: ${text}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    const items = object.orderItems?.filter((i) => i.query.trim().length > 0) ?? undefined;
    log.debug(
      `intent=${object.intent} items=${items?.length ?? 0} "${text.slice(0, 60)}"`,
    );
    return {
      intent: object.intent,
      orderItems: items?.length ? items : undefined,
    };
  } catch (err) {
    log.warn('Intent classify failed; defaulting to cook', err);
    return { intent: 'cook' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mid-confirm order action classifier.
//
// When the order workflow is in await_confirm and the user types something,
// we need to know whether they meant: confirm, cancel, add new items,
// remove existing line(s), change a line's quantity, or just chitchat.
//
// Regex can't disambiguate ("blue lays" appears in add and remove the same
// way), so the cart context is fed into the LLM and it returns a typed
// discriminated union. Callers branch on `action`.
// ─────────────────────────────────────────────────────────────────────────

const orderItemSchema = z.object({
  query: z.string().min(1),
  quantity: z.number().int().positive().default(1),
});

const orderActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('cancel') }),
  z.object({
    action: z.literal('add'),
    items: z.array(orderItemSchema).min(1),
  }),
  z.object({
    action: z.literal('remove'),
    /** 1-based cart line numbers as shown to the user. */
    targetLines: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.literal('set_quantity'),
    changes: z
      .array(
        z.object({
          lineIndex: z.number().int().positive(),
          quantity: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
  /** User said something unrelated to the order — re-prompt. */
  z.object({ action: z.literal('noop') }),
]);

export type OrderAction = z.infer<typeof orderActionSchema>;

export interface CartLineSummary {
  /** 1-based, matches what the user sees in the preview. */
  index: number;
  name: string;
  quantity: number;
  pricePaise: number;
}

const ORDER_ACTION_SYSTEM = `You decide what a user wants to do while staring at their pre-confirmation cart preview. Return exactly ONE action:

- confirm: yes / haan / chalo / go ahead / place it / ✅
- cancel: no / nahi / abort / cancel / stop / ✗
- add: user wants NEW items added. Return items[] with {query, quantity}.
- remove: user wants existing line(s) dropped. Return targetLines[] of 1-based line numbers from the cart.
- set_quantity: user wants a line's quantity changed. Return changes[] with {lineIndex, quantity}. quantity=0 is equivalent to remove. Use the CURRENT cart quantity to interpret "double", "half", "make it 5", etc.
- noop: unrelated chat the bot should ignore.

Cart line references (for remove / set_quantity): map fuzzy phrasing to the line number.
- "remove blue lays" / "drop the chips" / "take off the lays" → match by product name → that line's index
- "remove the first one" / "drop #2" → numeric reference → that index
- "make it 2 ice creams" → set_quantity, lineIndex=ice cream's number, quantity=2
- "double the chips" → set_quantity, current qty × 2

When the user mentions products NOT currently in the cart, treat as 'add'.

Be tolerant of mixed languages (Hindi/Hinglish/English) and casual phrasing. Default to 'noop' only when truly ambiguous — never fabricate cart lines that don't exist.`;

export async function classifyOrderAction(
  message: string,
  cart: CartLineSummary[],
): Promise<OrderAction> {
  const text = message.trim();
  if (text.length === 0) return { action: 'noop' };

  const cartBlock =
    cart.length === 0
      ? '(cart is empty)'
      : cart
          .map(
            (l) =>
              `${l.index}. ${l.name} × ${l.quantity}` +
              (l.pricePaise ? ` (₹${(l.pricePaise / 100).toFixed(0)} each)` : ''),
          )
          .join('\n');

  try {
    const { object } = await generateObject({
      model,
      schema: orderActionSchema,
      system: ORDER_ACTION_SYSTEM,
      prompt: `CURRENT CART:\n${cartBlock}\n\nUSER MESSAGE: ${text}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    log.debug(`order action=${object.action} "${text.slice(0, 60)}"`);
    return object;
  } catch (err) {
    log.warn('Order action classify failed; defaulting to noop', err);
    return { action: 'noop' };
  }
}
