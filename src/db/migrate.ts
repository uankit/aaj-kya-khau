import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'url';
import path from 'path';
import { db, pool } from '../config/database.js';

// Resolve migrations folder relative to this file so it works in both
// dev (src/db/migrate.ts) and prod (dist/db/migrate.js — where the build
// script copies the migrations folder).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.join(__dirname, 'migrations');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Running migrations from ${migrationsFolder}...`);
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log('Migrations complete.');
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
