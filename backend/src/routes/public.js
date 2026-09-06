'use strict';

// Public read-only site status page — the ONLY unauthenticated data endpoint in
// this API, and therefore the highest-risk file in the geo feature.
//
// Mounted by index.js as `app.use('/api/public', publicLimiter, …)` — deliberately
// ABOVE `app.use('/api', authenticate)`, because the whole point is that a
// logged-out visitor can open the page. The prefix is /api/public and NOT /public:
// nginx proxies only /api/ to the backend, so a bare /public path would fall into
// the SPA catch-all and 404 in production.
//
// The raw token travels in the X-Site-Token REQUEST HEADER, never in the path:
// nginx writes the full request path to access.log, and this token is a long-lived
// credential for a tenant's status page. The shareable URL stays
// https://modesp.com.ua/#/public/site/<token> — the fragment is never sent to the
// server, so the token appears in no server log and in no Referer.
//
// What may leave this file, and nothing else (Part 2 §7.7):
//   site   → name, city, region, country
//   device → { name, online, air_temp, alarm_active }
// NEVER a database id, mqtt_device_id, serial number, tenant slug or tenant id,
// firmware version, any user data, or coordinates finer than city. The device
// display label is computed HERE, server-side, so the codebase-wide
// `name || mqtt_device_id` display fallback cannot leak an id through a copy-paste.
//
// Unknown / revoked / expired tokens all return the IDENTICAL 404 body — a public
// endpoint must not confirm that a token ever existed.

const { Router } = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const emailSvc   = require('../services/email');

const router = Router();

// A base64url token of 32 random bytes is 43 chars; anything longer than this cap
// is not a token we ever minted, so it is rejected before reaching the hash.
const MAX_TOKEN_LENGTH = 256;
// A site with more cabinets than this is not a status page any more. Bounds the
// response of an endpoint anybody on the internet can call.
const MAX_PUBLIC_DEVICES = 200;

// ── Rate limiting ─────────────────────────────────────────
// The router carries its OWN strict limiter in addition to the `publicLimiter`
// index.js mounts in front of it: this endpoint must never be reachable without
// one, whatever a future mount site does. Keyed by IP — there is no user here.
// The store is kept in a module local so the suite can reset it between cases
// (a supertest run comes from a single IP and would otherwise trip the limit
// while asserting the 404 paths).
const limiterStore = new rateLimit.MemoryStore();

// ── Showcase links skip the limiter (plan epic 1.10) ──────
// site_public_links.rate_limit_exempt marks the demo site linked from the
// landing page. Its token hashes are cached here and refreshed every minute,
// so the check per request is one sha256 and a Set lookup — no query, and an
// unknown token is still limited exactly as before (the 404 path never skips).
const EXEMPT_REFRESH_MS = 60 * 1000;
let exemptHashes = new Set();
let exemptTimer = null;

async function refreshExempt() {
  try {
    const { rows } = await db.query(
      `SELECT token_hash FROM site_public_links
        WHERE rate_limit_exempt = true AND revoked_at IS NULL AND expires_at > NOW()`);
    exemptHashes = new Set(rows.map(r => r.token_hash));
  } catch (err) {
    // keep the previous set; a database hiccup must not open or close the gate
  }
  return exemptHashes.size;
}

function isExempt(req) {
  if (!exemptTimer) {
    exemptTimer = setInterval(refreshExempt, EXEMPT_REFRESH_MS);
    if (typeof exemptTimer.unref === 'function') exemptTimer.unref();
    refreshExempt();
  }
  if (exemptHashes.size === 0) return false;
  const token = readToken(req);
  if (!token) return false;
  return exemptHashes.has(crypto.createHash('sha256').update(token).digest('hex'));
}

const publicLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 30,                    // 30 views per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  store: limiterStore,
  skip: isExempt,
  message: { error: 'too_many_requests', message: 'Too many requests, try again later', status: 429 },
});

router.use(publicLimiter);

// ── Helpers ───────────────────────────────────────────────

// One body for every rejection: unknown token, revoked token, expired token, no
// header, malformed header. No WWW-Authenticate, no distinguishing message, no
// hint that the token was ever valid.
function notFound(res) {
  return res.status(404).json({ error: 'not_found', message: 'Not found', status: 404 });
}

// Never cached by a proxy, never indexed by a crawler that got hold of the URL.
function publicHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
}

function readToken(req) {
  const raw = req.get('X-Site-Token');
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

// Live MQTT values are already typed (services/mqtt.js parseScalar), but a
// controller can publish a non-numeric placeholder. Anything that is not a finite
// number is hidden rather than rendered raw on a public page.
function numericOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── GET /api/public/site ──────────────────────────────────
// Token in the X-Site-Token header. Answers without an Authorization header — a
// supertest asserts exactly that, so a future reorder of the index.js middleware
// chain fails a test instead of quietly returning 401.

router.get('/site', async (req, res) => {
  publicHeaders(res);

  const token = readToken(req);
  if (!token) return notFound(res);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    // Lookup + view accounting in ONE statement: exactly one parameterized
    // equality on the UNIQUE token_hash column (never "fetch candidates and
    // compare in JS"), and the increment cannot race two concurrent viewers.
    // Zero rows = unknown OR revoked OR expired — indistinguishable by design.
    const { rows: linkRows } = await db.query(
      `UPDATE site_public_links
          SET view_count = view_count + 1, last_viewed = NOW()
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
        RETURNING id, tenant_id, site_id, expires_at`,
      [tokenHash]
    );

    if (linkRows.length === 0) return notFound(res);

    const link = linkRows[0];

    // Re-verify the site against the LINK's tenant. The composite FK
    // (tenant_id, site_id) already makes a cross-tenant link impossible, so this
    // is belt-and-braces — but it is also what keeps an explicit tenant predicate
    // on every statement in this file, as the codebase requires.
    // Brand (plan epic 2.5): the organisation's own, else the partner's that
    // manages it, else nothing — the page then shows only "works on ModESP Cloud".
    const { rows: siteRows } = await db.query(
      `SELECT s.name, s.city, s.region, s.country, t.name AS organisation,
              COALESCE(own.brand_name, par.brand_name)         AS brand_name,
              COALESCE(own.brand_logo_url, par.brand_logo_url) AS brand_logo_url,
              COALESCE(own.brand_url, par.brand_url)           AS brand_url
         FROM sites s
         JOIN tenants t ON t.id = s.tenant_id
         LEFT JOIN tenant_settings own ON own.tenant_id = t.id
         LEFT JOIN tenant_settings par ON par.tenant_id = t.parent_tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2`,
      [link.site_id, link.tenant_id]
    );

    if (siteRows.length === 0) return notFound(res);

    const site = siteRows[0];
    const brand = site.brand_name || site.brand_logo_url
      ? { name: site.brand_name || null, logo_url: site.brand_logo_url || null, url: site.brand_url || null }
      : null;

    // status = 'active' AND deleted_at IS NULL: a soft-deleted device keeps its
    // site_id and lives for 7 more days, and pending devices exist too — neither
    // belongs on a public status page. mqtt_device_id is selected because the
    // live-state and alarm lookups are keyed by it; it never reaches the response.
    const { rows: deviceRows } = await db.query(
      `SELECT d.mqtt_device_id, d.name, d.online
         FROM devices d
        WHERE d.site_id = $1 AND d.tenant_id = $2
          AND d.status = 'active' AND d.deleted_at IS NULL
        ORDER BY d.name NULLS LAST, d.mqtt_device_id
        LIMIT $3`,
      [link.site_id, link.tenant_id, MAX_PUBLIC_DEVICES]
    );

    // Active alarms come from the alarms table so the public page agrees with the
    // authenticated site detail; live MQTT state adds the not-yet-persisted ones.
    let alarming = new Set();
    if (deviceRows.length > 0) {
      const { rows: alarmRows } = await db.query(
        `SELECT DISTINCT device_id FROM alarms
          WHERE tenant_id = $1 AND active = true AND device_id = ANY($2)`,
        [link.tenant_id, deviceRows.map(r => r.mqtt_device_id)]
      );
      alarming = new Set(alarmRows.map(r => r.device_id));
    }

    const devices = deviceRows.map((row, i) => {
      const live = mqttSvc.getDeviceState(row.mqtt_device_id);
      const meta = mqttSvc.getDeviceMeta(row.mqtt_device_id);
      // Positional label — NEVER the mqtt id, never a UUID, never a serial.
      const label = typeof row.name === 'string' && row.name.trim() !== ''
        ? row.name.trim()
        : `#${i + 1}`;
      return {
        name:         label,
        online:       meta ? !!meta.online : !!row.online,
        air_temp:     live ? numericOrNull(live['equipment.air_temp']) : null,
        alarm_active: (live ? !!live['protection.alarm_active'] : false)
                      || alarming.has(row.mqtt_device_id),
      };
    });

    res.json({
      data: {
        name:         site.name,
        organisation: site.organisation,       // whose page this is (plan epic 1.11)
        brand,                                 // who services it (plan epic 2.5), or null
        city:         site.city,
        region:       site.region,
        country:      site.country,
        link_expires_at: link.expires_at,      // lets the page warn a week ahead
        devices,
        device_count: devices.length,
        online_count: devices.filter(d => d.online).length,
        alarm_count:  devices.filter(d => d.alarm_active).length,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Public site page failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to load site', status: 500 });
  }
});

// ── GET /api/public/plans — pricing for the landing page (plan epic 1.11) ──
// The landing renders what the catalogue says, so the price list and the
// limits the platform enforces come from the same rows. Only public plans.
router.get('/plans', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  try {
    const { rows } = await db.query(
      `SELECT plan, name, tagline, max_devices, max_sites, max_users, retention_days, sampling_sec, features,
              price_controller_uah, price_site_uah, price_base_uah, price_note
         FROM plan_limits WHERE public = true ORDER BY sort_order`);
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'Public plans failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to load plans', status: 500 });
  }
});

// ── POST /api/public/pilot-request — the landing form (plan epic 1.11) ──
// Stored first (no lead is lost when e-mail is not configured), then mailed
// to PILOT_REQUEST_EMAIL. `website` is a honeypot: bots fill it, people never
// see it; a filled honeypot answers 200 and stores nothing.
const SEGMENTS = new Set(['service', 'retail', 'horeca', 'pharma', 'other']);

function clean(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

router.post('/pilot-request', async (req, res) => {
  publicHeaders(res);
  const body = req.body || {};
  if (clean(body.website, 10)) return res.status(200).json({ data: { received: true } });

  const name  = clean(body.name, 120);
  const email = clean(body.email, 254);
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'validation_failed', message: 'name and a valid email are required', status: 400 });
  }
  const segment = clean(body.segment, 32);
  const sites = Number.isInteger(body.sites) ? body.sites : parseInt(body.sites, 10);
  const lang = ['uk', 'en', 'pl', 'de'].includes(body.lang) ? body.lang : 'uk';
  const row = {
    name, email,
    company: clean(body.company, 160),
    phone:   clean(body.phone, 40),
    segment: segment && SEGMENTS.has(segment) ? segment : (segment ? 'other' : null),
    sites:   Number.isFinite(sites) && sites >= 0 && sites <= 100000 ? sites : null,
    message: clean(body.message, 4000),
    source:  clean(body.source, 64),
    lang,
  };
  try {
    const { rows } = await db.query(
      `INSERT INTO pilot_requests (name, company, email, phone, segment, sites, message, source, lang, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [row.name, row.company, row.email, row.phone, row.segment, row.sites, row.message, row.source, row.lang, req.ip || null]);
    const id = rows[0].id;
    let emailed = false;
    try {
      emailed = await emailSvc.sendPilotRequest({ to: process.env.PILOT_REQUEST_EMAIL, request: { id, ...row, created_at: rows[0].created_at } });
      if (emailed) await db.query('UPDATE pilot_requests SET emailed_at = NOW() WHERE id = $1', [id]);
    } catch (err) {
      req.log?.warn?.({ err }, 'Pilot request stored but not e-mailed');
    }
    req.log?.info?.({ id, segment: row.segment, emailed }, 'Pilot request received');
    res.status(201).json({ data: { received: true, emailed } });
  } catch (err) {
    req.log?.error?.({ err }, 'Pilot request failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to store the request', status: 500 });
  }
});

// ── GET /api/public/report/:code — HACCP report verification (plan epic 1.9) ──
// An inspector holding a printed report checks that the platform generated it:
// the code is on the footer, the SHA-256 covers the report data. Nothing
// beyond what the report itself already shows is returned — no ids, no
// telemetry, no user data — and an unknown code is the same 404 as a revoked one.
router.get('/report/:code', async (req, res) => {
  const code = String(req.params.code || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(code)) {
    return res.status(404).json({ error: 'not_found', message: 'Report not found', status: 404 });
  }
  try {
    const { rows } = await db.query(
      `SELECT r.code, r.kind, r.period_from, r.period_to, r.bucket, r.source, r.lang, r.sha256, r.generated_at,
              COALESCE(t.legal_name, t.name) AS organisation,
              s.name AS site_name, d.name AS device_name
         FROM report_exports r
         JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN sites s ON s.id = r.site_id
         LEFT JOIN devices d ON d.mqtt_device_id = r.device_id AND d.tenant_id = r.tenant_id
        WHERE r.code = $1`,
      [code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Report not found', status: 404 });
    }
    const r = rows[0];
    res.json({
      data: {
        code:         r.code.replace(/(.{4})(?=.)/g, '$1-'),
        kind:         r.kind,
        organisation: r.organisation,
        site:         r.site_name || null,
        device:       r.device_name || null,
        period_from:  r.period_from,
        period_to:    r.period_to,
        bucket:       r.bucket,
        source:       r.source,
        lang:         r.lang,
        sha256:       r.sha256,
        generated_at: r.generated_at,
        valid:        true,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Report verification failed');
    res.status(500).json({ error: 'internal_error', message: 'Verification failed', status: 500 });
  }
});

module.exports = router;

// Test hook: the limiter above lives for the lifetime of the router and a
// supertest suite makes every request from the same IP. Exposed so the suite can
// exercise both the limiter and the 404 paths without one starving the other.
// Not referenced by any production code path.
module.exports.resetRateLimit = () => limiterStore.resetAll();
module.exports.refreshExempt = refreshExempt;
module.exports.isExempt = isExempt;
