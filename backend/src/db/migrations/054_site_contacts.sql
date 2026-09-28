-- 054: a contact person on the trade point
--
-- A site had an address and coordinates but nobody to call. The technician who
-- arrives at a closed door, the dispatcher who has to warn the store that a
-- cabinet is being switched off, the report that names the responsible person —
-- all of them went looking in notes, in a work order, or in someone's phone.
--
-- Three nullable columns; nothing else changes. They are edited by the
-- organisation's admin on the site card, returned by GET /api/sites and
-- GET /api/sites/:id, and shown on the site page. The public status page does
-- not read them: a customer's screen in the back office is not the place for a
-- manager's phone number.
--
-- No index: the columns are read with the site row and never searched.
--
-- sites is created by 021_sites.sql (not by schema.sql), so this ALTER is the
-- only place the columns live — a fresh install and a migrated database get
-- them from the same statement. IF NOT EXISTS keeps a re-run harmless.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS contact_name  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(40),
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(160);
