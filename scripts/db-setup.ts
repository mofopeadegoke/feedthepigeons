import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env.local and run `pnpm db:setup`.');
  process.exit(1);
}

const sql = neon(url);
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
// The HTTP driver takes one statement per call, so the file is split on statement ends.
const statements = schema
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);

for (const statement of statements) await sql.query(statement);

const rows = await sql`SELECT COALESCE(SUM(count), 0) AS total FROM crumb_buckets`;
console.log(`crumb_buckets is ready (${String(rows[0]?.total ?? 0)} crumbs stored).`);
