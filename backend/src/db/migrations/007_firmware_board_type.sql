-- ModESP Cloud — Migration 007: Firmware Board Type
-- Phase 7d: OTA Board Compatibility
-- Run: psql -U modesp_cloud -d modesp_cloud -f backend/src/db/migrations/007_firmware_board_type.sql

-- Board type — which board modification this firmware targets
-- NULL = universal (compatible with all boards)
ALTER TABLE firmwares ADD COLUMN IF NOT EXISTS board_type VARCHAR(64);

-- Fast lookup: "list firmwares for this board type"
CREATE INDEX IF NOT EXISTS idx_firmwares_board
  ON firmwares(tenant_id, board_type);
