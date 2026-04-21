import type { FastifyInstance } from 'fastify';
import { getActiveCronCount } from '../services/scheduler.js';
import { getNightlyCronCount } from '../services/nightly.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      mealCrons: getActiveCronCount(),
      nightlyCrons: getNightlyCronCount(),
    };
  });
}
