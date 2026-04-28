/**
 * Web app plugin — registers all /api/* and onboarding routes.
 */

import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { chatRoutes } from './chat.js';
import { onboardingRoutes } from './onboarding.js';
import { zeptoOAuthRoutes } from './oauth-zepto.js';

export async function webRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(chatRoutes);
  await app.register(onboardingRoutes);
  await app.register(zeptoOAuthRoutes);
}
