-- 006: Per-device RBAC — indexes, audit columns for user_devices.

-- Audit columns: who granted access and when
ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- "Which users have access to device X?" (device detail page)
CREATE INDEX IF NOT EXISTS idx_user_devices_device ON user_devices(device_id);

-- "Which devices are accessible to user X?" (device list filtering)
CREATE INDEX IF NOT EXISTS idx_user_devices_user   ON user_devices(user_id);

-- Missing index for OTA queries (tenant + status lookups)
CREATE INDEX IF NOT EXISTS idx_ota_jobs_tenant_status ON ota_jobs(tenant_id, status);
