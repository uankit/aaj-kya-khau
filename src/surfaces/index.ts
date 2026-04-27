/**
 * Surface registry + delivery router.
 *
 * deliver(userId, content) is the single outbound entry point for domain
 * code (scheduler nudges, agent replies, workflow messages). It:
 *   1. Loads the user's primary_surface and bound external_id
 *   2. Picks the matching adapter
 *   3. Lowers content via adapter.send (or sendTemplate when needed — this
 *      is where the WhatsApp 24-hour-window policy will live)
 *
 * The user-resolution and template-vs-freeform decision logic is stubbed
 * for now; full implementation lands with the surface_bindings schema
 * (Step 4) and the WhatsApp template registry (later).
 */

import { telegramAdapter } from './telegram/adapter.js';
import {
  type OutboundContent,
  type SendResult,
  type SurfaceAdapter,
  SurfaceError,
  type SurfaceName,
} from './types.js';
import { whatsappAdapter } from './whatsapp/adapter.js';

export * from './types.js';
export { telegramAdapter, whatsappAdapter };

const adapters: Record<SurfaceName, SurfaceAdapter> = {
  telegram: telegramAdapter,
  whatsapp: whatsappAdapter,
};

export function adapterFor(surface: SurfaceName): SurfaceAdapter {
  return adapters[surface];
}

/**
 * Deliver a message to a user. Resolves the user's primary surface and
 * routes through the right adapter.
 *
 * Today: callers pass `{ surface, externalId }` directly because we don't
 * have surface_bindings yet. After Step 4, this signature changes to
 * `(userId, content)` with internal lookup.
 */
export async function deliver(
  target: { surface: SurfaceName; externalId: string },
  content: OutboundContent,
): Promise<SendResult> {
  const adapter = adapterFor(target.surface);
  if (!adapter) {
    throw new SurfaceError(`unknown surface: ${target.surface}`, target.surface, 'unknown_surface');
  }
  return adapter.send(target.externalId, content);
}
