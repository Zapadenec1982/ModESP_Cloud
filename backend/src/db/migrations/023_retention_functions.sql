-- 023: Partition lifecycle as owner-privileged functions
--
-- On production the telemetry parent table and its partitions are owned by the
-- postgres role (schema.sql is applied with `sudo -u postgres psql`), while the
-- backend and every maintenance script connect as DB_USER, which has DML grants
-- only. Two consequences:
--   * create_telemetry_partition() failed with "must be owner of table telemetry"
--     for anyone but postgres, so ensure-partitions.js could not be used and the
--     partition timer had to run psql as the postgres OS user;
--   * cleanup-telemetry.js could never DROP a partition as DB_USER, so the 90-day
--     retention documented everywhere was not actually applied.
--
-- Both operations now run inside SECURITY DEFINER functions with a fixed
-- search_path and strict input validation, so all systemd timers can run as the
-- unprivileged app user with the credentials from backend/.env.
--
-- Apply as the schema owner (DDL), e.g.:
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -d modesp_cloud \
--     -f backend/src/db/migrations/023_retention_functions.sql
-- or through the runner with owner credentials (docs/DEPLOYMENT.md, "Оновлення").

CREATE OR REPLACE FUNCTION create_telemetry_partition(year INT, month INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  IF year IS NULL OR month IS NULL OR year < 2020 OR year > 2100 OR month < 1 OR month > 12 THEN
    RAISE EXCEPTION 'create_telemetry_partition: invalid year/month %/%', year, month;
  END IF;

  partition_name := format('telemetry_%s_%s', year, lpad(month::TEXT, 2, '0'));
  start_date := make_date(year, month, 1);
  end_date := start_date + INTERVAL '1 month';

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.telemetry
     FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );

  -- Unique index for ON CONFLICT DO NOTHING (backfill dedup)
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (tenant_id, device_id, channel, time)',
    'idx_' || partition_name || '_unique', partition_name
  );
END;
$$;

-- Detaches and drops one monthly partition. Returns TRUE when a partition was
-- dropped, FALSE when nothing by that name is attached (idempotent re-runs).
-- Refuses anything that is not a telemetry_YYYY_MM name and, as a hard floor
-- independent of the configured retention, any partition whose range ended
-- less than 7 days ago — a broken TELEMETRY_RETENTION_DAYS must never be able
-- to take the live month down.
CREATE OR REPLACE FUNCTION drop_telemetry_partition(partition_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  y INT;
  m INT;
  range_end DATE;
BEGIN
  IF partition_name IS NULL OR partition_name !~ '^telemetry_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'drop_telemetry_partition: "%" is not a telemetry_YYYY_MM partition name', partition_name;
  END IF;

  y := substring(partition_name FROM 11 FOR 4)::INT;
  m := substring(partition_name FROM 16 FOR 2)::INT;
  IF m < 1 OR m > 12 THEN
    RAISE EXCEPTION 'drop_telemetry_partition: "%" has an invalid month', partition_name;
  END IF;
  range_end := (make_date(y, m, 1) + INTERVAL '1 month')::DATE;

  IF range_end > (now() - INTERVAL '7 days')::DATE THEN
    RAISE EXCEPTION 'drop_telemetry_partition: % ends on %, refusing to drop a partition younger than 7 days',
      partition_name, range_end;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_inherits
     WHERE inhparent = 'public.telemetry'::regclass
       AND inhrelid  = to_regclass('public.' || partition_name)
  ) THEN
    RETURN FALSE;
  END IF;

  EXECUTE format('ALTER TABLE public.telemetry DETACH PARTITION public.%I', partition_name);
  EXECUTE format('DROP TABLE IF EXISTS public.%I', partition_name);
  RETURN TRUE;
END;
$$;

-- Functions are executable by PUBLIC by default; a SECURITY DEFINER function that
-- drops tables must not be. Each GRANT/REVOKE stays on one physical line
-- (test/helpers/migrate.js comments out ^(GRANT|REVOKE)\b.*$ per line).
REVOKE ALL ON FUNCTION create_telemetry_partition(INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION drop_telemetry_partition(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_telemetry_partition(INT, INT) TO modesp_cloud;
GRANT EXECUTE ON FUNCTION drop_telemetry_partition(TEXT) TO modesp_cloud;
