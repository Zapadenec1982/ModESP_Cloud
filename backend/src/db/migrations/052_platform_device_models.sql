-- 052: platform equipment models, the same shape firmware already has
--
-- device_models.tenant_id was NOT NULL, so a model always belonged to exactly one
-- organisation. But a power profile for «бонета 2.5 м» is not one customer's
-- secret — it is a property of the equipment, and several organisations running
-- the same cabinet want the same numbers. With no way to say «platform», someone
-- put the model under the system organisation (tenant_id = the all-zero
-- SYSTEM_TENANT_ID) and pointed devices of real organisations at it.
--
-- That worked until the devices↔device_models joins gained
-- `m.tenant_id = d.tenant_id` (PR #57). The predicate is right — a device must
-- not read another CUSTOMER's model — but it collapsed the legitimate
-- platform-wide case into the illegitimate cross-customer one, and those devices
-- silently lost their energy estimate: the model stopped matching, and their own
-- *_kw columns were empty.
--
-- Firmware solved this long ago and this mirrors it exactly:
--   firmwares.tenant_id     NULL → platform firmware, visible to every organisation
--   device_models.tenant_id NULL → platform model,    visible to every organisation
--
-- Only a superadmin creates or edits one; an organisation sees it and may point
-- its devices at it, but cannot change or delete it.

ALTER TABLE device_models ALTER COLUMN tenant_id DROP NOT NULL;

-- UNIQUE (tenant_id, name) treats NULLs as distinct, so it does not stop two
-- platform models sharing a name. Same guard firmware needed
-- (uq_firmwares_global_version), same reason.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_models_global_name
  ON device_models (name) WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_models_global
  ON device_models (name) WHERE tenant_id IS NULL;

-- Models parked under the system organisation were platform models in intent —
-- that is the only reason to put one there, since the system organisation owns
-- no equipment of its own, only devices waiting to be claimed. Making them
-- platform models restores exactly the behaviour they had before PR #57, for the
-- devices that are pointing at them right now.
--
-- A name collision cannot happen here: the system organisation already held at
-- most one model per name (device_models_tenant_id_name_key), and the partial
-- index above is created before this runs, so a genuine duplicate would fail the
-- migration rather than pass silently.
UPDATE device_models
   SET tenant_id = NULL
 WHERE tenant_id = '00000000-0000-0000-0000-000000000000';
