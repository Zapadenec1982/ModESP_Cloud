-- HACCP report for inspectors: excursion rules (journal form 2026-09, part 2)
--
-- devices.haccp_tolerance          — allowed deviation above the upper (below the lower) critical
--                                    limit, °C: "not above −18 °C, allowed deviation 3 °C" means an
--                                    excursion starts past −15 °C. NULL = 0.
-- tenant_settings.haccp_excursion_min — how long the air temperature must stay past the limit
--                                    before it counts as a product excursion (minutes, NULL = 30).
-- sites.haccp_excursion_min        — the same per site, overrides the organisation's value.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS haccp_tolerance NUMERIC(4,1);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_haccp_tolerance_check;
ALTER TABLE devices ADD CONSTRAINT devices_haccp_tolerance_check CHECK (haccp_tolerance IS NULL OR haccp_tolerance >= 0);

ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS haccp_excursion_min INT;
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_haccp_excursion_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_haccp_excursion_check CHECK (haccp_excursion_min IS NULL OR (haccp_excursion_min >= 1 AND haccp_excursion_min <= 1440));

ALTER TABLE sites ADD COLUMN IF NOT EXISTS haccp_excursion_min INT;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_haccp_excursion_check;
ALTER TABLE sites ADD CONSTRAINT sites_haccp_excursion_check CHECK (haccp_excursion_min IS NULL OR (haccp_excursion_min >= 1 AND haccp_excursion_min <= 1440));
