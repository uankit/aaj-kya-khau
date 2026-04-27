/**
 * Grocery provider registry.
 *
 * Today: Zepto only. Tomorrow: per-user / per-region routing across Zepto,
 * Blinkit, Instamart. Domain code calls `getGroceryProvider(userId)` instead
 * of importing Zepto directly so that swap is a one-line change.
 */

import { hasZeptoConnected } from './zepto/account.js';
import { zeptoProvider } from './zepto/provider.js';
import {
  type GroceryProvider,
  GroceryProviderNotConnectedError,
  type ProviderName,
} from './types.js';

export * from './types.js';
export { zeptoProvider };

/**
 * Resolve the grocery provider for a user.
 *
 * Future: read user.preferred_grocery_provider, check connection status of
 * each, fall back through a priority chain. For now: Zepto only.
 */
export async function getGroceryProvider(userId: string): Promise<GroceryProvider> {
  if (await hasZeptoConnected(userId)) return zeptoProvider;
  throw new GroceryProviderNotConnectedError('zepto');
}

/** Static lookup by name. Useful for tooling that knows which provider it wants. */
export function providerByName(name: ProviderName): GroceryProvider {
  switch (name) {
    case 'zepto':
      return zeptoProvider;
  }
}
