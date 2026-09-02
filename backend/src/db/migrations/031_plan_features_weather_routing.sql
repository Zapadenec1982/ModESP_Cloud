-- 031: weather and route planning as plan features (plan epic 1.2)
--
-- Outdoor weather (Open-Meteo, paid) and the service-round planner (OSRM,
-- self-hosted) cost money per organisation; they are part of the network and
-- partner plans, not of the single-site plan. The features array already
-- gates HACCP PDF (reports), energy and isochrones (geo).
UPDATE plan_limits
   SET features = features || '["weather"]'::jsonb
 WHERE plan IN ('pro', 'enterprise', 'partner') AND NOT features ? 'weather';
UPDATE plan_limits
   SET features = features || '["routing"]'::jsonb
 WHERE plan IN ('pro', 'enterprise', 'partner') AND NOT features ? 'routing';
