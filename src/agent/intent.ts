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

Output exactly one intent.`;

function formatHistory(history: HistoryMessage[]): string {
  if (history.length === 0) return '(no prior messages)';
  return history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 240)}`)
    .join('\n');
}

/**
 * Classify the user's current message into an intent via the LLM. Uses
 * recent history to disambiguate short replies. Never throws — returns
 * 'cook' on failure.
 */
export async function classifyIntent(
  currentMessage: string,
  history: HistoryMessage[] = [],
): Promise<Intent> {
  const text = currentMessage.trim();
  if (text.length === 0) return 'chitchat';

  try {
    const { object } = await generateObject({
      model,
      schema: IntentSchema,
      system: CLASSIFY_SYSTEM,
      prompt: `RECENT CONVERSATION:\n${formatHistory(history)}\n\nCURRENT MESSAGE: ${text}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    log.debug(`intent=${object.intent} "${text.slice(0, 60)}"`);
    return object.intent;
  } catch (err) {
    log.warn('Intent classify failed; defaulting to cook', err);
    return 'cook';
  }
}
