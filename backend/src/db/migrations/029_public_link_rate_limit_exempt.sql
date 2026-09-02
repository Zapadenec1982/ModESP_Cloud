-- 029: showcase public links (plan epic 1.10)
--
-- The landing page links to the status page of a demo site. That page is
-- opened by many visitors, some of them behind one corporate NAT, so the
-- per-IP limiter of /api/public (30 views / 5 min) would turn the showcase
-- into a 429. Links flagged here skip that limiter; every other link keeps
-- it, and the flag is set only by the seed script or a superadmin in SQL.
ALTER TABLE site_public_links
  ADD COLUMN IF NOT EXISTS rate_limit_exempt BOOLEAN NOT NULL DEFAULT false;
