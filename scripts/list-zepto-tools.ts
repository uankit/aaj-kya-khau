/**
 * Dump the full Zepto MCP tool catalog (names, descriptions, input schemas)
 * for an already-connected user.
 *
 * Run: `npx tsx scripts/list-zepto-tools.ts <userId>`
 */

import 'dotenv/config';

import { and, eq } from 'drizzle-orm';
import { db } from '../src/config/database.js';
import { connectedAccounts } from '../src/db/schema.js';
import { listWarmZeptoTools } from '../src/providers/grocery/zepto/session.js';

let userId = process.argv[2];
if (!userId) {
  const [row] = await db
    .select({ userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.provider, 'zepto'), eq(connectedAccounts.status, 'active')))
    .limit(1);
  if (!row) {
    console.error('No active Zepto-connected user found. Pass a userId explicitly.');
    process.exit(1);
  }
  userId = row.userId;
  console.log(`Using auto-picked Zepto-connected user: ${userId}\n`);
}

const tools = await listWarmZeptoTools(userId);

console.log(`\nFound ${tools.length} tools:\n`);
for (const t of tools) {
  console.log('─'.repeat(72));
  console.log(`• ${t.name}`);
  if (t.description) console.log(`  ${t.description}`);
  if (t.inputSchema) {
    console.log('  inputSchema:');
    console.log(
      JSON.stringify(t.inputSchema, null, 2)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );
  }
}
console.log('─'.repeat(72));
process.exit(0);
