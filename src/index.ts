import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { pool } from './config/database.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhook.js';
import { loadAllSchedules } from './services/scheduler.js';
import { loadAllNightlyCrons } from './services/nightly.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  },
  // Telegram sends JSON update bodies; 1 MB is plenty.
  bodyLimit: 1024 * 1024,
  trustProxy: true,
});

async function bootstrap() {
  // Light rate limiting. Telegram retries aggressively on failures, and
  // this also protects against accidental message storms from a buggy user.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  await app.register(healthRoutes);
  await app.register(webhookRoutes);

  // Load all existing crons from the DB so they survive restarts.
  await loadAllSchedules();
  await loadAllNightlyCrons();

  // Bind to '::' (IPv6 unspecified) for dual-stack (both IPv4 and IPv6).
  // Railway's edge proxy routes via IPv6 internally — binding to '0.0.0.0'
  // only listens on IPv4 and causes 502s.
  const address = await app.listen({ port: env.PORT, host: '::' });
  app.log.info(`🍽️  Aaj Kya Khaun listening at ${address}`);
}

bootstrap().catch((err) => {
  app.log.error(err, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`Received ${sig}, shutting down...`);
    try {
      await app.close();
      await pool.end();
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
    }
    process.exit(0);
  });
}
