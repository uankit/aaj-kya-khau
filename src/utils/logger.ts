import { env } from '../config/env.js';

// Fastify provides its own Pino logger; for use outside Fastify (cron, migrations, etc.)
// we fall back to a simple namespaced console logger. Keeping it dead simple so there's
// one fewer dependency to think about.
type Level = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = levelOrder[(env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function log(level: Level, ns: string, message: string, meta?: unknown) {
  if ((levelOrder[level] ?? 20) < currentLevel) return;
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.toUpperCase()} [${ns}] ${message}`;
  // eslint-disable-next-line no-console
  const fn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) fn(base, meta);
  else fn(base);
}

export function createLogger(namespace: string) {
  return {
    debug: (msg: string, meta?: unknown) => log('debug', namespace, msg, meta),
    info: (msg: string, meta?: unknown) => log('info', namespace, msg, meta),
    warn: (msg: string, meta?: unknown) => log('warn', namespace, msg, meta),
    error: (msg: string, meta?: unknown) => log('error', namespace, msg, meta),
  };
}
