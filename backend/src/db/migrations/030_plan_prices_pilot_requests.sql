-- 030: public pricing and pilot requests (plan epic 1.11)
--
-- plan_limits gets the list prices the landing page shows, so the pricing
-- page and the catalogue can never disagree (GET /api/public/plans reads
-- both from one row). Prices are UAH per month without VAT, per the analysis
-- (docs/BUSINESS_ANALYSIS_SAAS_UA.md §5.2); NULL = "on request".
-- pilot_requests stores what the landing form sends even when e-mail is not
-- configured, so no lead is lost.

ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS tagline               VARCHAR(120);
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_controller_uah  INT;
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_site_uah        INT;
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_base_uah        INT;
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_note            VARCHAR(200);

UPDATE plan_limits SET tagline = 'Пілот, один об''єкт',
       price_controller_uah = 0, price_site_uah = NULL, price_base_uah = NULL,
       price_note = 'Безкоштовно: 1 точка, до 3 контролерів, 30 днів історії'
 WHERE plan = 'free' AND tagline IS NULL;
UPDATE plan_limits SET tagline = 'Аптека, кафе, магазин',
       price_controller_uah = 150, price_site_uah = NULL, price_base_uah = NULL,
       price_note = 'за контролер на місяць; річна передоплата −15 %'
 WHERE plan = 'basic' AND tagline IS NULL;
UPDATE plan_limits SET tagline = 'Від 5 до 150 точок',
       price_controller_uah = 100, price_site_uah = 250, price_base_uah = NULL,
       price_note = 'за точку + за контролер; від 100 контролерів — 80 грн, від 500 — 60 грн'
 WHERE plan = 'pro' AND tagline IS NULL;
UPDATE plan_limits SET tagline = 'Сервісна компанія',
       price_controller_uah = 100, price_site_uah = NULL, price_base_uah = 2000,
       price_note = 'партнерський рахунок + за контролер клієнтів; від 100 — 80 грн, від 300 — 70 грн'
 WHERE plan = 'partner' AND tagline IS NULL;
UPDATE plan_limits SET tagline = 'Великі мережі, держустанови',
       price_controller_uah = NULL, price_site_uah = NULL, price_base_uah = NULL,
       price_note = 'окрема інсталяція, SLA, API — від 200 000 грн на рік'
 WHERE plan = 'enterprise' AND tagline IS NULL;

CREATE TABLE IF NOT EXISTS pilot_requests (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  company     VARCHAR(160),
  email       VARCHAR(254) NOT NULL,
  phone       VARCHAR(40),
  segment     VARCHAR(32),                    -- service | retail | horeca | pharma | other
  sites       INT,                            -- how many sites they run
  message     TEXT,
  source      VARCHAR(64),                    -- landing section / campaign
  lang        VARCHAR(2)   NOT NULL DEFAULT 'uk',
  ip          INET,
  emailed_at  TIMESTAMPTZ,                    -- when the founder was notified
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pilot_requests_created ON pilot_requests (created_at DESC);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE ON pilot_requests TO modesp_cloud;
