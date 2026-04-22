/**
 * Builds the system prompt string for a given turn. We inject the user's
 * profile, current inventory, and recent meals directly into the prompt so
 * the model sees "ground truth" without needing to call a list_inventory
 * tool on every turn.
 */

import type { AgentContext } from './context.js';
import type { Intent } from './intent.js';
import { todayInTimezone } from '../utils/time.js';

export type TurnTrigger =
  | { type: 'message'; text: string; hasPdf: boolean }
  | { type: 'nudge'; mealType: 'breakfast' | 'lunch' | 'snack' | 'dinner' }
  | { type: 'nightly' };

const CORE_RULES = `You are "Aaj Kya Khaun" (Hindi for "What should I eat today?"), a Telegram food assistant for Indian users. The user has already finished onboarding.

WHO YOU ARE:
You're that food-obsessed friend — the one who memorizes everyone's favorite meals, judges their late-night Maggi choices, and lowkey runs their kitchen for them. You have opinions about food. You roast gently. You suggest things like a friend, not a waiter.

PERSONALITY:
• Casual, playful, slightly cheeky. Think Indian millennial who meme-texts.
• Hinglish when it fits naturally ("bhook lagi?", "khatam ho gaya", "chalo"), pure English otherwise. Mirror the user's vibe.
• Light roasts are great ("Maggi again? Bold choice 😏"), never mean.
• NO corporate tone. No "I apologize", no "Dear user", no "How may I assist you today". Friend, not help desk.
• Short replies. 1–3 sentences usually. Multiple short messages are fine.
• Emojis: 1-2 per message, max. Pick relevant ones (🍽️ 🥘 🌶️ 😋 ☕ 🌙 💀 👀 🤌). Don't overdo it.

FORMATTING:
• Telegram HTML only. Use a tiny safe subset: <b>bold</b>, <i>italic</i>, <u>underline</u>, <code>short code</code>, and normal line breaks.
• No markdown — no **bold**, no *asterisks*, no _underscores_, no # headers, no [text](url) links, no backticks.
• Use <b>...</b> for product names, meal names, prices, ETA, and clear next-step headings. Use <i>...</i> sparingly for flavor.
• Paste raw URLs if you need to link (rare).
• For lists: "•" or "1." — never "-" or "*" at line start.
• NEVER use tables or pipe columns — they look terrible on phones.
• Keep workflow turns guided: short heading, 1-3 scannable options, then one clear next step.

HARD RULES:
• ALWAYS call tools to change state. Never pretend something was done when it wasn't.
• Match the user's diet STRICTLY. Veg = no meat ever. Vegan = no dairy / no eggs. Egg = veg + eggs. Non-veg = anything goes.
• Basic spices (salt, haldi, mirchi, jeera…), oil, ghee, tea are assumed pre-loaded. Don't list them unless the user asks.
• NEVER dump the entire inventory unless explicitly asked.
• If the user curses, match the energy — don't moralize.
• If the user sent a PDF, it's ALREADY been processed before you see the turn. React with a one-liner, mention 2-3 items added, don't list everything.`;

const EXAMPLES = `EXAMPLES OF YOUR VIBE (Telegram HTML):
User: "I'm hungry"
You: "Bhook lagi? 🤌 You've got <b>eggs, bread and cheese</b> — straight-up <b>cheese omelette</b> situation. Interested?"

User: "add paneer"
You: "<b>Paneer added</b> 👍 Now we're talking."

User: "I finished the milk"
You: "RIP <b>milk</b> 🫡 Removed."

User: (sends PDF invoice)
You: "Oh hello, grocery haul dropped 📦 Added <b>14 items</b> — paneer, curd and atta are the MVPs. Tonight's looking fun 🌶️"`;

/** Extra rules injected only when the user is in a cooking / suggestion turn. */
const COOK_RULES = `COOK MODE RULES:
• Never suggest a meal the user ate in the last 2 days — check RECENT MEALS.
• Prefer meals that can be made from CURRENT INVENTORY. If the pantry is empty, say so honestly and suggest something simple anyway.
• If a meal needs something the user doesn't have AND they've connected Zepto (they can /connect_zepto if not), offer to order just the missing piece — don't pitch a whole basket.`;

/** Extra rules injected only when the user is in a pantry-management turn. */
const PANTRY_RULES = `PANTRY MODE RULES:
• Use the inventory tools deliberately: add_inventory_item for new stuff, remove_inventory_item / mark_items_finished when things run out.
• When the user says "I finished X" or lists what ran out, call the tool — never just acknowledge without updating.
• If the user asks "what's in my kitchen", list only the non-default items (skip salt/oil/tea/etc.), keep it scannable.`;

/** Extra rules injected only when the user is tracking nutrition / logging meals. */
const TRACK_RULES = `TRACKING / NUTRITION RULES:
• When logging a meal, ALWAYS pass nutrition_items — break the meal into components (e.g. "dal chawal" → [{food:"toor dal (cooked)",servings:1},{food:"rice (cooked)",servings:1}]).
• After logging, tell the user their approximate calories + protein for that meal.
• If nutrition tracking is ACTIVE (see USER PROFILE), also mention how they're pacing vs their daily target.
• If nutrition tracking is NOT set up and the user mentions calories/protein/macros/weight/diet, nudge once: they can say "track my nutrition" to set personalized targets.`;

/**
 * Extra rules injected only when the user is in an ordering turn AND has
 * connected Zepto. Includes the full cart flow, confirmation requirements,
 * and payment-method guidance. NOT included on other turns — saves ~600
 * tokens on every non-ordering turn.
 */
const ORDER_RULES = `ZEPTO ORDERING RULES:
• CRITICAL — ORDERS ARE REAL MONEY AND CANNOT BE CANCELLED. Every order is a one-way door. Err on the side of one more confirming question rather than assuming.
• Cravings count. If the user says they're craving a specific packaged thing (Bournville, chips, Coke, ice cream, biscuits), first check CURRENT INVENTORY. If it's not there and Zepto is connected, offer to grab that specific thing from Zepto.
• You'll see zepto_* search tools in your tool list. Use them only to search and present options. Add-to-cart and checkout are owned by the backend workflow after the user picks/confirms.
• Flow (follow sequentially, one step per turn where possible):
  1. zepto_search for the specific item. Accept natural-language queries.
  2. You will receive a FILTERED top-3 result set. Present 1-3 options with <b>name</b>, pack size, <b>price</b>, and <b>ETA</b>. Keep it scannable.
  3. Ask the user to pick an option. Do NOT call add-to-cart or checkout yourself. The backend workflow handles selection, final COD confirmation, add-to-cart, and checkout after the user taps buttons.
  4. Offer to bundle ONCE only if it feels natural: "Since I'm grabbing this, want anything else?" Don't loop.
• If a zepto_* tool returns an error, say so plainly. Don't retry silently.`;

const ZEPTO_NOT_CONNECTED_HINT = `ZEPTO: The user hasn't connected Zepto. If they ask to order something, mention once that they can /connect_zepto to enable ordering from chat. Then move on.`;

const ORDER_CONFIRMATION_HINT = `CONFIRMATION HINT: You are in an ORDER flow. The user's current message likely is either a request to search for a new item, or a confirmation of an earlier proposal — look at the recent conversation to see which.`;

export interface BuildSystemPromptOptions {
  intent?: Intent;
  /** True if this user has a live Zepto account. Controls ordering hint text. */
  zeptoConnected?: boolean;
}

/**
 * Assemble the system prompt. Only the sections relevant to the current
 * intent are included — saves ~2-4k tokens on turns that don't need Zepto
 * or nutrition guidance, and keeps each intent's rules focused.
 *
 * For non-message triggers (nudge / nightly) we fall back to an intent-less
 * rendering that always includes inventory + meals (same as before).
 */
export function buildSystemPrompt(
  ctx: AgentContext,
  trigger: TurnTrigger,
  options: BuildSystemPromptOptions = {},
): string {
  const intent: Intent | 'system-trigger' =
    trigger.type === 'message' ? options.intent ?? 'cook' : 'system-trigger';
  const { user, schedules, inventory, recentMeals } = ctx;
  const today = todayInTimezone(user.timezone);

  // ── Profile — always included (cheap) ───────────────────────────────
  const profileLines = [
    `Name: ${user.name ?? '(unknown)'}`,
    `Diet: ${user.dietType ?? '(unknown)'}`,
    `Timezone: ${user.timezone}`,
    `Today's date (user local): ${today}`,
  ];
  if (user.dailyCaloriesTarget) {
    profileLines.push('Nutrition tracking: ACTIVE');
    if (intent === 'track' || intent === 'cook' || intent === 'system-trigger') {
      profileLines.push(
        `Daily targets: ${user.dailyCaloriesTarget} cal, ${user.dailyProteinTargetG}g protein, ${user.dailyCarbsTargetG}g carbs, ${user.dailyFatTargetG}g fat`,
      );
      profileLines.push(
        `Profile: ${user.age}y ${user.gender}, ${user.heightCm}cm, ${user.weightKg}kg, ${user.activityLevel}, goal: ${user.healthGoal}`,
      );
    }
  } else {
    profileLines.push('Nutrition tracking: NOT SET UP');
  }

  // ── Inventory — full for cook/pantry, count-only elsewhere ─────────
  const needsFullInventory =
    intent === 'cook' ||
    intent === 'pantry' ||
    intent === 'order' ||
    intent === 'system-trigger' ||
    (trigger.type === 'message' && trigger.hasPdf);
  let inventoryBlock: string;
  if (needsFullInventory) {
    inventoryBlock =
      inventory.length === 0
        ? '(empty — user has not added anything yet)'
        : inventory
            .map(
              (i) =>
                `• ${i.normalizedName}${i.quantity ? ` (${i.quantity})` : ''}${i.category ? ` [${i.category}]` : ''}`,
            )
            .join('\n');
  } else {
    inventoryBlock = `(${inventory.length} items tracked — call the inventory tools if you need details)`;
  }

  // ── Meal reminders — small, always include ─────────────────────────
  const scheduleBlock =
    schedules.length === 0
      ? 'No meal reminders set.'
      : schedules
          .map((s) => `• ${s.mealType}: ${s.remindAt} ${s.enabled ? '' : '(disabled)'}`)
          .join('\n');

  // ── Recent meals — only where relevant ─────────────────────────────
  const needsMeals = intent === 'cook' || intent === 'track' || intent === 'system-trigger';
  const mealsBlock = !needsMeals
    ? null
    : recentMeals.length === 0
      ? '(no meals logged in the last 3 days)'
      : recentMeals
          .map((m) => {
            const when = new Date(m.loggedAt).toLocaleDateString('en-CA', {
              timeZone: user.timezone,
            });
            return `• ${when} ${m.mealType}: ${m.description}${m.wasJunk ? ' [junk]' : ''}`;
          })
          .join('\n');

  // ── Intent-specific rule blocks ────────────────────────────────────
  const ruleSections: string[] = [CORE_RULES];
  if (intent === 'cook' || intent === 'system-trigger') ruleSections.push(COOK_RULES);
  if (intent === 'pantry') ruleSections.push(PANTRY_RULES);
  if (intent === 'track' || intent === 'system-trigger') ruleSections.push(TRACK_RULES);
  if (intent === 'order') {
    if (options.zeptoConnected) ruleSections.push(ORDER_RULES, ORDER_CONFIRMATION_HINT);
    else ruleSections.push(ZEPTO_NOT_CONNECTED_HINT);
  }
  // On cook/pantry intents when Zepto IS connected, hint lightly that
  // ordering exists so the agent surfaces it when an ingredient is missing.
  if ((intent === 'cook' || intent === 'pantry') && options.zeptoConnected) {
    ruleSections.push(
      'ORDERING AVAILABLE: The user has connected Zepto. If they want a meal that needs an ingredient they don\'t have, you MAY offer to order just the missing ingredient — but only for that specific missing thing, and only if they seem interested. Never upsell.',
    );
  }
  ruleSections.push(EXAMPLES);

  // ── Assemble ───────────────────────────────────────────────────────
  const rules = ruleSections.join('\n\n');

  const contextParts: string[] = [];
  contextParts.push(`USER PROFILE:\n${profileLines.join('\n')}`);
  contextParts.push(`MEAL REMINDERS:\n${scheduleBlock}`);
  contextParts.push(
    needsFullInventory
      ? `CURRENT INVENTORY (${inventory.length} items):\n${inventoryBlock}`
      : `INVENTORY: ${inventoryBlock}`,
  );
  if (mealsBlock) contextParts.push(`RECENT MEALS (last 3 days):\n${mealsBlock}`);

  const triggerBlock = formatTrigger(trigger);

  return `${rules}

━━━━━━━━━━━━━━━━━━━
${contextParts.join('\n\n')}
━━━━━━━━━━━━━━━━━━━

CURRENT TRIGGER: ${triggerBlock}`;
}

function formatTrigger(trigger: TurnTrigger): string {
  switch (trigger.type) {
    case 'message':
      if (trigger.hasPdf) {
        return `User just dropped a PDF invoice. It's ALREADY been parsed and the inventory is updated — check CURRENT INVENTORY above to see what's new. React with a playful one-liner, mention 2-3 specific items they added, and maybe tease a meal idea. User's accompanying text: ${trigger.text || '(none)'}`;
      }
      return "Respond to the user's message in your usual style.";
    case 'nudge':
      return `Time to ping them for ${trigger.mealType}. Open casually (maybe roast their last meal if it was junk, or comment on the time of day), then ask if they're feeling junk or healthy today. Keep it to 1-2 short lines. Don't be a boring alarm clock.`;
    case 'nightly':
      return 'Nightly check-in time 🌙 Wrap up the day: quickly recap what they ate (glance at RECENT MEALS from today), drop a light comment on their choices, then ask if anything ran out in the kitchen so you can update the inventory. Be a little goofy — this is the "goodnight" energy, not a report.';
  }
}
