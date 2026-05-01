import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { pool } from './config/database.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhook.js';
import { webRoutes } from './web/index.js';
import { loadAllSchedules } from './services/scheduler.js';
import { loadAllNightlyCrons } from './services/nightly.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the public directory whether we're running from src (dev via tsx)
// or dist (prod). In both cases, go up from this file's dir to find /public.
function resolvePublicDir(): string {
  const candidates = [
    path.resolve(__dirname, 'public'),             // dist/index.js with public copied into dist/public
    path.resolve(__dirname, '..', 'public'),       // dist/index.js → <root>/public
    path.resolve(__dirname, '..', '..', 'public'), // src/index.ts  → <root>/public
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  throw new Error(`public/index.html not found. Tried: ${candidates.join(', ')}`);
}

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

  // Cookies for web sessions.
  await app.register(cookie, { secret: env.SESSION_SECRET });

  // Serve CSS/JS/images from /public/ under the /static/ URL prefix.
  const publicDir = resolvePublicDir();
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/static/',
  });

  // Read landing / onboarding / settings HTML once at boot.
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
  const startHtml = fs.readFileSync(path.join(publicDir, 'start.html'), 'utf-8');
  const appHtml = fs.readFileSync(path.join(publicDir, 'app.html'), 'utf-8');
  const settingsHtml = fs.readFileSync(path.join(publicDir, 'settings.html'), 'utf-8');
  app.get('/', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(indexHtml);
  });
  app.get('/start', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(startHtml);
  });
  app.get('/app', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(appHtml);
  });
  app.get('/settings', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(settingsHtml);
  });

  // SEO: robots.txt + sitemap.xml at root. Crawlers expect these paths.
  // PUBLIC_BASE_URL drives the absolute URLs in the sitemap so we don't
  // accidentally publish staging URLs to Google.
  const canonical = (env.PUBLIC_BASE_URL ?? 'https://aajkyakhaun.com').replace(/\/$/, '');
  const robotsTxt = `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nSitemap: ${canonical}/sitemap.xml\n`;
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${canonical}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${canonical}/start</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
</urlset>
`;
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send(robotsTxt));
  app.get('/sitemap.xml', async (_req, reply) => reply.type('application/xml').send(sitemapXml));
  app.get('/sw.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').send('// no service worker\n'),
  );

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(webRoutes);

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
