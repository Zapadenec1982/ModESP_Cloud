-- Migration 009: Add superadmin role
-- The role column is VARCHAR(16) without CHECK constraint,
-- so no ALTER needed. This migration adds a CHECK constraint
-- to enforce valid roles going forward.

-- Add CHECK constraint for role values
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin', 'admin', 'technician', 'viewer'));

-- Update schema.sql comment: role now includes 'superadmin'
COMMENT ON COLUMN users.role IS 'superadmin | admin | technician | viewer';
