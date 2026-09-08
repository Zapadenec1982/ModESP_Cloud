-- 044: CSV imports as background jobs (plan epic 2.12)
--
-- A CSV of up to IMPORT_MAX_ROWS (2 000) devices and sites is validated in
-- the request, then processed in the background: the job row carries the
-- parsed rows, the progress counters the UI polls, the per-row results and
-- the MQTT credentials of freshly assigned controllers — encrypted, handed
-- out once (credentials_downloaded_at) and then wiped.

CREATE TABLE IF NOT EXISTS imports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  status                   VARCHAR(10) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  file_name                VARCHAR(160),
  total_rows               INT NOT NULL DEFAULT 0,
  processed_rows           INT NOT NULL DEFAULT 0,
  assigned                 INT NOT NULL DEFAULT 0,
  pre_registered           INT NOT NULL DEFAULT 0,
  skipped                  INT NOT NULL DEFAULT 0,
  failed_rows              INT NOT NULL DEFAULT 0,
  sites_created            INT NOT NULL DEFAULT 0,
  devices_with_site        INT NOT NULL DEFAULT 0,
  geocode_queued           INT NOT NULL DEFAULT 0,
  geocoded                 INT NOT NULL DEFAULT 0,
  geocode_failed           INT NOT NULL DEFAULT 0,
  rows                     JSONB,                  -- the parsed CSV rows, cleared when the job ends
  results                  JSONB,                  -- per-row outcome without secrets
  credentials_enc          TEXT,                   -- encrypted JSON of the new MQTT credentials
  credentials_downloaded_at TIMESTAMPTZ,
  cancel_requested         BOOLEAN NOT NULL DEFAULT false,
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_imports_tenant ON imports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imports_active ON imports (status) WHERE status IN ('pending', 'running');

GRANT SELECT, INSERT, UPDATE, DELETE ON imports TO modesp_cloud;
