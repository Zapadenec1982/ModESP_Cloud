-- Migration 011: Bootstrap password fallback for go-auth
-- Allows deleted/stuck devices to reconnect using bootstrap password.
-- go-auth userquery falls back to this table when device is not in devices table.

CREATE TABLE IF NOT EXISTS mqtt_bootstrap (
  id   INT  PRIMARY KEY DEFAULT 1,
  password_hash TEXT NOT NULL,
  CHECK (id = 1)  -- singleton row
);

-- go-auth connects as modesp_mqtt_ro (read-only)
GRANT SELECT ON mqtt_bootstrap TO modesp_mqtt_ro;
