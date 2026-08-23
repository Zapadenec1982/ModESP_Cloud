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
const publicLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 30,                    // 30 views per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  store: limiterStore,
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
        RETURNING id, tenant_id, site_id`,
      [tokenHash]
    );

    if (linkRows.length === 0) return notFound(res);

    const link = linkRows[0];

    // Re-verify the site against the LINK's tenant. The composite FK
    // (tenant_id, site_id) already makes a cross-tenant link impossible, so this
    // is belt-and-braces — but it is also what keeps an explicit tenant predicate
    // on every statement in this file, as the codebase requires.
    const { rows: siteRows } = await db.query(
      `SELECT name, city, region, country
         FROM sites
        WHERE id = $1 AND tenant_id = $2`,
      [link.site_id, link.tenant_id]
    );

    if (siteRows.length === 0) return notFound(res);

    const site = siteRows[0];

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
        city:         site.city,
        region:       site.region,
        country:      site.country,
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

module.exports = router;

// Test hook: the limiter above lives for the lifetime of the router and a
// supertest suite makes every request from the same IP. Exposed so the suite can
// exercise both the limiter and the 404 paths without one starving the other.
// Not referenced by any production code path.
module.exports.resetRateLimit = () => limiterStore.resetAll();
