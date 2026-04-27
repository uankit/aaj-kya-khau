/**
 * Surface registry + delivery router.
 *
 * Today: Telegram is the only chat surface. The adapter abstraction is
 * preserved so adding another surface (Discord, Slack, etc.) later is
 * mechanical.
 */

import { telegramAdapter } from './telegram/adapter.js';
import {
  type OutboundContent,
  type SendResult,
  type SurfaceAdapter,
  SurfaceError,
  type SurfaceName,
} from './types.js';

export * from './types.js';
export { telegramAdapter };

const adapters: Record<SurfaceName, SurfaceAdapter> = {
  telegram: telegramAdapter,
};

export function adapterFor(surface: SurfaceName): SurfaceAdapter {
  return adapters[surface];
}

/**
 * Deliver a message to a user. Resolves the user's primary surface and
 * routes through the right adapter.
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
