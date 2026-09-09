-- 049: unique indexes that exist only in schema.sql
--
-- A production database is created from whatever schema.sql said on its install
-- day and carried forward by migrations ever since. Five unique indexes were
-- added straight to schema.sql with no migration behind them, so a fresh install
-- has them and every database in the field does not:
--
--   idx_events_dedup                (tenant_id, device_id, event_type, time)
--   idx_telemetry_2026_03..06_unique(tenant_id, device_id, channel, time)
--
-- Both back an `ON CONFLICT DO NOTHING` written without a conflict target, so the
-- absence is silent — no error, just no deduplication. A controller catching up
-- after an outage re-sends buffered readings; without the index every retry
-- inserts them again. Duplicate events double-count compressor starts, which the
-- short-cycle hints run on; duplicate telemetry inflates the HACCP report and the
-- storage bill.
--
-- The telemetry half is written as a loop rather than four names: a database in
-- the field may carry partitions created by hand, and every one of them needs the
-- index create_telemetry_partition() gives to the ones it makes.
--
-- Duplicates already in the tables have to go first or the unique index cannot be
-- built. The lowest id (events) / lowest ctid (telemetry) survives, so the
-- first-seen row is the one kept.

-- ── events ───────────────────────────────────────────────────
DELETE FROM events
 WHERE id IN (
   SELECT id FROM (
     SELECT id, row_number() OVER (
              PARTITION BY tenant_id, device_id, event_type, time ORDER BY id) AS rn
       FROM events
   ) d WHERE d.rn > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup
  ON events (tenant_id, device_id, event_type, time);

-- ── every attached telemetry partition ───────────────────────
DO $$
DECLARE
  part   TEXT;
  idxname TEXT;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'telemetry' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    idxname := 'idx_' || part || '_unique';
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class WHERE relname = idxname AND relkind = 'i'
    );

    -- ctid is unique inside one partition, and this DELETE names the leaf table,
    -- so it cannot reach across partitions the way the retention sweep once did
    -- (migration 040 / PR #40).
    EXECUTE format(
      'DELETE FROM public.%I WHERE ctid IN (
         SELECT ctid FROM (
           SELECT ctid, row_number() OVER (
                    PARTITION BY tenant_id, device_id, channel, time ORDER BY ctid) AS rn
             FROM public.%I
         ) d WHERE d.rn > 1)', part, part);

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (tenant_id, device_id, channel, time)',
      idxname, part);

    RAISE NOTICE 'migration 049: created % on %', idxname, part;
  END LOOP;
END $$;
