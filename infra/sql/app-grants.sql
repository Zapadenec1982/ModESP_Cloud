-- Application role privileges (plan epic 1.10).
--
-- The schema is owned by the role that ran schema.sql + migrate.js (postgres on
-- a VPS, see infra/setup.sh); the application role gets DML only. Default
-- privileges make tables and sequences that FUTURE migrations create visible
-- to the application without a manual GRANT — the mistake this file exists to
-- prevent. The same file runs in infra/setup.sh, infra/deploy.sh and the CI
-- "migrations" job, which then verifies the result with check-grants.sql.
--
-- Usage:
--   psql -v ON_ERROR_STOP=1 -v app_user=modesp_cloud -v owner=postgres -d modesp_cloud -f infra/sql/app-grants.sql
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"app_user";
