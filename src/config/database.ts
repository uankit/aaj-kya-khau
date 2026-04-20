import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from './env.js';
import * as schema from '../db/schema.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Bumped from 10 to 25 to reduce contention when multiple webhook turns
  // run concurrently (each agent turn may hold a connection for several
  // seconds while it awaits the LLM). Railway's Postgres addon comfortably
  // handles this and then some.
  max: 25,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Every query gets a hard ceiling so a hung query can't indefinitely pin
  // a connection. Kept well under LLM_TIMEOUT_MS (30s) so the DB kills bad
  // queries before the LLM layer even reaches its own abort. Client-side
  // (query_timeout) should be slightly longer than server-side (statement_timeout)
  // to give Postgres time to cancel gracefully before the client bails.
  statement_timeout: 15_000,
  query_timeout: 20_000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected PG pool error', err);
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
