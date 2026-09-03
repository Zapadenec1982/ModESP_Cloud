-- Fails (non-zero psql exit with ON_ERROR_STOP) when the application role
-- cannot read and write every table or use every sequence in the schema.
-- Run after migrations, on CI and on a server:
--   psql -v ON_ERROR_STOP=1 -v app_user=modesp_cloud -d modesp_cloud -f infra/sql/check-grants.sql
SELECT set_config('modesp.app_user', :'app_user', false) AS app_user \gset

DO $$
DECLARE
  app     text := current_setting('modesp.app_user');
  missing text;
BEGIN
  -- CASE keeps the privilege functions from being evaluated on the wrong relkind
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND CASE WHEN c.relkind IN ('r', 'p')
              THEN NOT has_table_privilege(app, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
              ELSE false END;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % lacks DML on: %', app, missing;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND CASE WHEN c.relkind = 'S'
              THEN NOT has_sequence_privilege(app, c.oid, 'USAGE, SELECT')
              ELSE false END;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % lacks USAGE on sequences: %', app, missing;
  END IF;

  IF NOT has_function_privilege(app, 'public.create_telemetry_partition(int, int)', 'EXECUTE')
     OR NOT has_function_privilege(app, 'public.drop_telemetry_partition(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'role % cannot execute the partition functions (migration 023)', app;
  END IF;

  RAISE NOTICE 'role % can reach every table, sequence and partition function', app;
END $$;
