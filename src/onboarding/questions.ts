/**
 * Scripted onboarding questions. Each step has:
 *   - a prompt shown to the user
 *   - a validator returning the parsed value or an error string
 *   - the next step on success
 *
 * Times use HH:MM (24-hour). "skip" is accepted for meal-time steps so the
 * user can opt out of specific meal reminders.
 */

import { parseTimeOfDay, formatTimeOfDay } from '../utils/time.js';

export type OnboardingStep =
  | 'ask_name'
  | 'ask_diet'
  | 'ask_breakfast_time'
  | 'ask_lunch_time'
  | 'ask_snack_time'
  | 'ask_dinner_time'
  | 'complete';

export type DietType = 'veg' | 'non-veg' | 'egg' | 'vegan';

export type MealType = 'breakfast' | 'lunch' | 'snack' | 'dinner';

export interface StepResult<T> {
  ok: true;
  value: T;
}
export interface StepError {
  ok: false;
  error: string;
}

export const ONBOARDING_PROMPTS: Record<OnboardingStep, (name?: string) => string> = {
  ask_name: () =>
    "Oye! 👋\n\nThe name's *Aaj Kya Khaun* — literally 'what should I eat today', which is the only real question in life tbh 🍽️\n\nThink of me as that one friend who's *always* thinking about food and won't let you eat Maggi three nights in a row.\n\nSo... what do I call you?",

  ask_diet: (name) =>
    `Noted, ${name} 📝\n\nQuick vibe check — what's your food situation?\n\n*1* 🥦 Pure veg (dal chawal squad)\n*2* 🍗 Non-veg (chicken in the house)\n*3* 🥚 Egg-etarian (veg + anda)\n*4* 🌱 Vegan (no dairy, no drama)\n\nJust reply with the number.`,

  ask_breakfast_time: () =>
    "Cool cool 😎\n\nNow the serious business — meal reminders, so I can bug you at the right time.\n\nWhen do you usually have *breakfast*? ☕🍳\nReply in HH:MM format (like *08:30*).\n\nOr type *skip* if you're one of those 'breakfast is a scam' people 🙄",

  ask_lunch_time: () =>
    'And *lunch*? 🍛\n\n(HH:MM — or *skip* if lunch is more of a concept to you)',

  ask_snack_time: () =>
    "Snack o'clock? 🍿\n\n(HH:MM — or *skip*, no judgment if you're a proud 3-meals-only warrior)",

  ask_dinner_time: () =>
    "And finally — *dinner* 🌙\n\n(HH:MM — or *skip* if you're on that intermittent fasting grind)",

  complete: (name) =>
    `Boom 💥 We're in business, ${name}!\n\nHere's the drill:\n\n📄 *Drop your grocery bills here* — PDFs from Blinkit / Zepto / BigBasket etc. I'll magically turn them into your kitchen inventory.\n\n🍴 Say *"bhook lagi"* or *"I'm hungry"* anytime and I'll suggest something based on what you *actually* have. No 'sorry we don't have that' moments.\n\n⏰ I'll ping you at meal times so you don't end up doomscrolling through Swiggy at midnight 👀\n\n✍️ Boss me around:\n   • *"add paneer"*\n   • *"milk khatam"*\n   • *"what's in my kitchen?"*\n\n🔬 *Bonus:* Say *"track my nutrition"* and I'll set up personalized calorie & macro targets based on your body profile. Science-backed (IFCT 2017 + ICMR guidelines), not guesswork.\n\nNow go dig up a grocery invoice and let's see what's cooking 🧑‍🍳`,
};

/** Validates the name step. */
export function validateName(input: string): StepResult<string> | StepError {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Uhh, silence? 🙃 Come on, gimme a name." };
  }
  if (trimmed.length > 100) {
    return {
      ok: false,
      error: "Arre bhai, that's a whole paragraph 😅 Shorter please — just a name.",
    };
  }
  if (/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: "Nice try, but I need an actual name — not a number 😒 What do your friends call you?",
    };
  }
  return { ok: true, value: trimmed };
}

const DIET_ALIASES: Record<string, DietType> = {
  '1': 'veg',
  veg: 'veg',
  vegetarian: 'veg',
  '2': 'non-veg',
  'non-veg': 'non-veg',
  'non veg': 'non-veg',
  nonveg: 'non-veg',
  'non-vegetarian': 'non-veg',
  '3': 'egg',
  egg: 'egg',
  eggetarian: 'egg',
  '4': 'vegan',
  vegan: 'vegan',
};

export function validateDiet(input: string): StepResult<DietType> | StepError {
  const key = input.trim().toLowerCase();
  const match = DIET_ALIASES[key];
  if (!match) {
    return {
      ok: false,
      error:
        "Hmm, that's not on the menu 🤨\n\nPick one:\n*1* Veg, *2* Non-veg, *3* Egg, *4* Vegan",
    };
  }
  return { ok: true, value: match };
}

/**
 * Validates a meal-time input. Returns:
 *   - { ok: true, value: 'HH:MM:SS' } if a valid time
 *   - { ok: true, value: null } if user said "skip"
 *   - { ok: false, error } otherwise
 */
export function validateTime(
  input: string,
): StepResult<string | null> | StepError {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'skip' || trimmed === 'no' || trimmed === 'none') {
    return { ok: true, value: null };
  }
  const parsed = parseTimeOfDay(trimmed);
  if (!parsed) {
    return {
      ok: false,
      error:
        "That's not a time, boss 🕐\n\nFormat is *HH:MM* (like *08:30* or *21:15*). Or just type *skip*.",
    };
  }
  return { ok: true, value: formatTimeOfDay(parsed.hour, parsed.minute) };
}

/** Maps a meal-time step to its meal type. */
export function stepToMealType(step: OnboardingStep): MealType | null {
  switch (step) {
    case 'ask_breakfast_time':
      return 'breakfast';
    case 'ask_lunch_time':
      return 'lunch';
    case 'ask_snack_time':
      return 'snack';
    case 'ask_dinner_time':
      return 'dinner';
    default:
      return null;
  }
}

/** Returns the next step after the given one. */
export function nextStep(step: OnboardingStep): OnboardingStep {
  const order: OnboardingStep[] = [
    'ask_name',
    'ask_diet',
    'ask_breakfast_time',
    'ask_lunch_time',
    'ask_snack_time',
    'ask_dinner_time',
    'complete',
  ];
  const idx = order.indexOf(step);
  return order[idx + 1] ?? 'complete';
}
