-- 025: Claim codes for pending controllers (plan epic 1.7)
--
-- Before: every organisation admin saw every pending device in the platform
-- and could assign any of them to their own organisation. Now a pending device
-- is visible to (and assignable by) an organisation only after one of its
-- admins has entered the claim code printed on the controller. Superadmins
-- keep the full list.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS claim_code           VARCHAR(12),
  ADD COLUMN IF NOT EXISTS claimed_by_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_claim_code
  ON devices (claim_code) WHERE claim_code IS NOT NULL AND status = 'pending';

-- Devices already waiting in the queue get a code the superadmin can hand over
-- (hex from md5 — readable enough for a one-off backfill; new codes come from
-- backend/src/lib/claim-code.js with an unambiguous alphabet).
UPDATE devices
   SET claim_code = upper(substr(md5(random()::text || id::text), 1, 8))
 WHERE claim_code IS NULL AND status = 'pending';
