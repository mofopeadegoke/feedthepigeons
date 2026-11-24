-- One row per minute rather than per crumb, so a busy minute is still a single cheap upsert.
CREATE TABLE IF NOT EXISTS crumb_buckets (
  minute_start timestamptz PRIMARY KEY,
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0)
);
