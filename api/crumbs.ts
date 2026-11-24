import { neon } from '@neondatabase/serverless';

/** Matches the client's own cap, so honest batches never get trimmed. */
const MAX_PER_REQUEST = 100;
/** Comfortably larger than any real batch body; anything bigger isn't worth parsing. */
const MAX_BODY_BYTES = 1024;

type Sql = ReturnType<typeof neon>;
let cached: Sql | null = null;

function db(): Sql {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cached = neon(url);
  return cached;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The total moves every few seconds; a cached copy would make the count-up look stuck.
      'cache-control': 'no-store',
    },
  });
}

function toTotal(rows: unknown): number {
  const row = Array.isArray(rows) ? (rows[0] as { total?: unknown } | undefined) : undefined;
  // Postgres sums come back as strings because bigint can outgrow a JS number; ours never will.
  const n = Number(row?.total ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

async function readCount(request: Request): Promise<number | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const count = (body as { count?: unknown } | null)?.count;
  if (typeof count !== 'number' || !Number.isFinite(count)) return null;
  const whole = Math.floor(count);
  if (whole < 1) return null;
  // Clamped rather than rejected, so an over-eager batch still counts for something.
  return Math.min(whole, MAX_PER_REQUEST);
}

export async function GET(): Promise<Response> {
  try {
    const rows = await db()`
      SELECT COALESCE(SUM(count), 0) AS total
      FROM crumb_buckets
      WHERE minute_start > now() - interval '24 hours'
    `;
    return json({ total: toTotal(rows) });
  } catch (err) {
    console.error('crumbs GET failed', err);
    return json({ error: 'unavailable' }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const count = await readCount(request);
  if (count === null) return json({ error: 'expected { "count": n } with n >= 1' }, 400);
  try {
    // One round trip: prune, bump this minute, and sum. The sum reads the snapshot from before
    // the upsert, which is why `count` is added to it afterwards.
    const rows = await db()`
      WITH pruned AS (
        DELETE FROM crumb_buckets WHERE minute_start <= now() - interval '24 hours'
      ), bumped AS (
        INSERT INTO crumb_buckets (minute_start, count)
        VALUES (date_trunc('minute', now()), ${count})
        ON CONFLICT (minute_start) DO UPDATE SET count = crumb_buckets.count + EXCLUDED.count
      )
      SELECT COALESCE(SUM(count), 0) + ${count} AS total
      FROM crumb_buckets
      WHERE minute_start > now() - interval '24 hours'
    `;
    return json({ total: toTotal(rows) });
  } catch (err) {
    console.error('crumbs POST failed', err);
    return json({ error: 'unavailable' }, 503);
  }
}
