/**
 * WhatsApp template registry.
 *
 * Twilio's Cloud API requires a Content SID (e.g. "HX...") to send a
 * pre-approved template message. We map a logical template name (used in
 * domain code: "meal_nudge_lunch", "order_confirmed") to its Content SID.
 *
 * SIDs are env-driven so they can rotate without code changes:
 *   TWILIO_TEMPLATE_MEAL_NUDGE_BREAKFAST=HXxxxx
 *   TWILIO_TEMPLATE_MEAL_NUDGE_LUNCH_DINNER=HXxxxx
 *   TWILIO_TEMPLATE_NIGHTLY_SUMMARY=HXxxxx
 *   TWILIO_TEMPLATE_RESTOCK_LOW=HXxxxx
 *   TWILIO_TEMPLATE_ORDER_CONFIRMED=HXxxxx
 *
 * Get SIDs from the Twilio Content API dashboard after Meta approves each
 * template. Resolving an unknown / unconfigured template throws — domain
 * code should fail visibly rather than silently dropping a nudge.
 */

import { SurfaceError } from '../types.js';

export type WhatsAppTemplateName =
  | 'meal_nudge_breakfast'
  | 'meal_nudge_lunch_dinner'
  | 'nightly_summary'
  | 'restock_low'
  | 'order_confirmed';

export function resolveTemplateSid(name: string): string {
  const envKey = `TWILIO_TEMPLATE_${name.toUpperCase()}`;
  const sid = process.env[envKey];
  if (!sid) {
    throw new SurfaceError(
      `WhatsApp template "${name}" not configured. Set ${envKey} in env.`,
      'whatsapp',
      'template_not_configured',
    );
  }
  return sid;
}

/**
 * Build the contentVariables payload Twilio expects: an object keyed by
 * 1-based positional index ({"1": "...", "2": "..."}). Mirror's the way
 * Twilio Content templates declare variables.
 */
export function buildContentVariables(params: string[]): string {
  const obj: Record<string, string> = {};
  params.forEach((value, idx) => {
    obj[String(idx + 1)] = value;
  });
  return JSON.stringify(obj);
}
