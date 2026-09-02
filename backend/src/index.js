'use strict';

require('dotenv').config();

const http     = require('http');
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const pino     = require('pino');
const path        = require('path');
const db          = require('./services/db');
const mqttSvc     = require('./services/mqtt');
const wsSvc       = require('./services/ws');
const pushSvc     = require('./services/push');
const telegramSvc = require('./services/telegram');
const fcmSvc      = require('./services/fcm');
const webpushSvc  = require('./services/webpush');
const emailSvc    = require('./services/email');
const otaSvc      = require('./services/ota');
const geocodeSvc  = require('./services/geocode');
const weatherSvc  = require('./services/weather');
const routingSvc  = require('./services/routing');
const tenantMw    = require('./middleware/tenant');
const { authenticate, authorize, requireSuperadmin } = require('./middleware/auth');
const createAuditMiddleware = require('./middleware/audit');

const { timingSafeEqual } = require('crypto');
const { generateClaimCode, normalizeClaimCode } = require('./lib/claim-code');
const { DANGEROUS_KEYS } = require('./config/command-policy');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

// ── Security guards ────────────────────────────────────
if (!AUTH_ENABLED && process.env.NODE_ENV === 'production') {
  logger.fatal('AUTH_ENABLED=false is not allowed in production — exiting');
  process.exit(1);
}
if (AUTH_ENABLED) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change-me-to-a-random-string' || secret.length < 32) {
    logger.fatal('JWT_SECRET must be set to a random string of at least 32 characters');
    process.exit(1);
  }
}

// ── Third-party licensing reminder ────────────────────────
// Nominatim, Open-Meteo, the OSRM demo server and OpenRouteService are all free for
// NON-COMMERCIAL use only. ModESP Cloud is a commercial product, so every enabled
// service needs a paid plan or a self-hosted instance before production.
// Warn only — never process.exit: breaking a running production system over a
// licensing note would be worse than the note being missed.
function logThirdPartyLicensing() {
  const enabled = [];
  if (geocodeSvc.isEnabled())         enabled.push('Nominatim (geocoding)');
  if (weatherSvc.isEnabled())         enabled.push('Open-Meteo (outdoor weather, site timezones)');
  if (routingSvc.isEnabled())         enabled.push('OSRM (route / service-round planning)');
  if (routingSvc.isochronesEnabled()) enabled.push('OpenRouteService (isochrones)');
  if (enabled.length === 0) return;

  const message = 'Third-party geo services are enabled under free / non-commercial terms — '
    + 'buy a plan or self-host before production. See docs/THIRD_PARTY_LICENSING.md';
  if (process.env.NODE_ENV === 'production') {
    logger.warn({ services: enabled }, message);
  } else {
    logger.info({ services: enabled }, message);
  }
}
logThirdPartyLicensing();

// ── Express ───────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Trust proxy (Nginx sets X-Forwarded-For / X-Real-IP)
app.set('trust proxy', 'loopback');

// Body parsing
app.use(express.json({ limit: '100kb' }));

// CORS (dev: Vite on 5173, prod: same-origin via Nginx)
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'"],
      styleSrc:      ["'self'", "'unsafe-inline'"], // Svelte inline styles
      imgSrc:        ["'self'", "data:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"], // OSM tiles (map page)
      connectSrc:    ["'self'", "wss:", "ws:", "https://api.pwnedpasswords.com"], // WebSocket + HIBP k-anonymity check
      fontSrc:       ["'self'"],
      objectSrc:     ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting — auth & registration endpoints
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 50,                    // 50 attempts per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts, try again later', status: 429 },
});
// Self-service password reset and invitation acceptance: public, email-keyed
// flows. 10 per IP per hour is generous for a human and useless for enumeration.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts, try again later', status: 429 },
});
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts, try again later', status: 429 },
});
// Device self-registration. The endpoint is already gated by MQTT_BOOTSTRAP_PASSWORD
// (timing-safe compare), so this limiter is not the primary gate — its job is to stop
// someone brute-forcing that bootstrap key. Counting SUCCESSFUL registrations was
// therefore protecting nothing while breaking the legitimate case: one commissioning
// site is one IP, and a store with 40 cabinets — or a test bench bringing up a whole
// fleet — hit the wall long before finishing. skipSuccessfulRequests inverts that:
// the budget is spent only on failures, so key-guessing is throttled harder than
// before (30 wrong keys per IP per hour) while a valid key can register any number
// of distinct devices.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,                    // 30 FAILED attempts per IP
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many registration attempts', status: 429 },
});
// Public site status page — unauthenticated, so the only key available is the IP.
// Showcase links (site_public_links.rate_limit_exempt) skip it, see routes/public.js.
const publicRoutes = require('./routes/public');
const publicLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 30,                    // 30 views per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => publicRoutes.isExempt(req),
  message: { error: 'too_many_requests', message: 'Too many requests, try again later', status: 429 },
});
// Routes that reach a third party (Nominatim / Open-Meteo / OSRM / OpenRouteService).
// Keyed on the user id, not the IP — a whole tenant can sit behind one NAT, and nginx
// applies no limit_req to the general /api/ location.
const externalLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 min
  max: 30,                    // 30 upstream-backed calls per user per min
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user?.id || rateLimit.ipKeyGenerator(req.ip),
  message: { error: 'too_many_requests', message: 'Too many requests, try again later', status: 429 },
});

// ── Health check (no auth / no tenant; /details authenticates itself) ──
app.use('/api/health', require('./routes/health'));

// ── Parameter metadata (no auth — same for all devices) ──────────
const stateMeta = require('./config/state_meta.json');
// `dangerous` marks the keys POST /devices/:id/command accepts only with
// confirm: true (config/command-policy.js) — the WebUI asks before sending them.
const stateMetaResponse = {
  ...stateMeta,
  meta: stateMeta.meta.map(m => ({ ...m, dangerous: DANGEROUS_KEYS.has(m.key) })),
};
app.get('/api/meta', (_req, res) => {
  res.json(stateMetaResponse);
});

// ── VAPID public key for Web Push (no auth — needed before subscription) ──
app.get('/api/vapid-public-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'Web Push not configured',
      status: 503,
    });
  }
  res.json({ data: { publicKey: key } });
});

// ── Device self-registration (no JWT, requires bootstrap key) ───────
// Devices call this before connecting to MQTT (port 8883 with go-auth).
// Creates a pending device in DB with bootstrap credentials so go-auth
// can authenticate the device. Admin then assigns tenant via WebUI.
const bcrypt = require('bcrypt');
let _bootstrapHash = null; // lazy-computed, cached
// P0-2: how long an active device must be offline before the shared bootstrap key
// is allowed to reset it to pending. A genuine factory-reset device cannot pass
// go-auth and is therefore offline; this window blocks replayed-key abuse of live devices.
const RESET_OFFLINE_GRACE_MS = parseInt(process.env.RESET_OFFLINE_GRACE_MS, 10) || 10 * 60 * 1000;

app.post('/api/devices/register', registerLimiter, async (req, res) => {
  const bootstrapKey = process.env.MQTT_BOOTSTRAP_PASSWORD;
  if (!bootstrapKey) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'Bootstrap registration not configured',
      status: 503,
    });
  }

  // Validate bootstrap key (header or body) — timing-safe comparison
  const providedKey = req.headers['x-bootstrap-key'] || req.body?.bootstrap_key;
  if (!providedKey) {
    return res.status(401).json({
      error: 'unauthorized', message: 'Invalid bootstrap key', status: 401,
    });
  }
  const keyBuf = Buffer.from(bootstrapKey);
  const providedBuf = Buffer.from(providedKey);
  if (keyBuf.length !== providedBuf.length || !timingSafeEqual(keyBuf, providedBuf)) {
    return res.status(401).json({
      error: 'unauthorized', message: 'Invalid bootstrap key', status: 401,
    });
  }

  const { device_id } = req.body || {};
  if (!device_id || !/^[A-Fa-f0-9]{6,12}$/.test(device_id)) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'device_id is required (6-12 hex chars, e.g. "A4CF12")',
      status: 400,
    });
  }

  const mqttDeviceId = device_id.toUpperCase();
  const username = `device_${mqttDeviceId}`;
  // Claim code printed on the controller (plan epic 1.7). Reported by the
  // firmware when it was flashed at production; generated otherwise so the
  // superadmin can hand it to the organisation.
  const claimCode = normalizeClaimCode(req.body?.claim_code) || generateClaimCode();

  try {
    // Lazy-compute bootstrap hash (once, cached for process lifetime)
    if (!_bootstrapHash) {
      _bootstrapHash = await bcrypt.hash(bootstrapKey, 12);
    }

    // Check if device already exists
    const existing = await db.query(
      `SELECT mqtt_device_id, mqtt_username,
              (mqtt_password_hash IS NOT NULL) AS has_creds, status,
              online, last_seen
       FROM devices WHERE mqtt_device_id = $1`,
      [mqttDeviceId]
    );

    if (existing.rows.length > 0) {
      const dev = existing.rows[0];
      if (dev.has_creds && dev.status === 'pending') {
        // Pending device already has bootstrap creds — idempotent
        return res.json({
          data: {
            device_id: mqttDeviceId,
            username: dev.mqtt_username,
            broker: process.env.MQTT_PUBLIC_HOST || 'modesp.com.ua',
            port: 8883,
            prefix: `modesp/v1/pending/${mqttDeviceId}`,
            status: dev.status,
            created: false,
          },
        });
      }
      if (dev.has_creds && dev.status === 'active') {
        // P0-2 guard: a genuinely factory-reset device cannot authenticate to MQTT
        // (go-auth rejects its erased unique creds), so it is necessarily OFFLINE.
        // A recently-seen active device asking to reset with the SHARED bootstrap key
        // is illegitimate (replayed key → credential-downgrade / DoS) — refuse and
        // require an admin to run /api/devices/recover.
        //
        // devices.online is NOT part of this test, deliberately. Every writer of that
        // column is tenant-scoped (handleStatus, stateWriter and offlineDetector in
        // services/mqtt.js all match on tenant_id), and a device publishing under the
        // 'pending' slug resolves to the SYSTEM tenant — so for a device stranded on the
        // wrong prefix the flag is frozen at whatever it was when the assign moved the
        // row, which for a freshly-assigned device is `true`. Gating on it locked the
        // exact population this endpoint exists to rescue out of the documented
        // self-heal, with a 409, permanently. last_seen freezes the same way but is
        // monotonic, so it ages past the grace window and lets a genuinely stranded
        // device through while still refusing one that is demonstrably talking.
        const lastSeenMs   = dev.last_seen ? new Date(dev.last_seen).getTime() : 0;
        const offlineForMs = Date.now() - lastSeenMs;
        if (offlineForMs < RESET_OFFLINE_GRACE_MS) {
          logger.warn(
            { device_id: mqttDeviceId, online: dev.online, offlineForMs },
            'Bootstrap reset refused: active device seen too recently — requires admin recover'
          );
          return res.status(409).json({
            error: 'device_active',
            message: 'Device is active and online; credential reset requires admin action',
            status: 409,
          });
        }
        // Offline beyond the grace window → legitimate factory-reset recovery, proceed.
        // Active device re-registering → it lost its provisioned credentials.
        // Reset to pending with bootstrap creds so it can reconnect.
        await db.query(
          `UPDATE devices
              SET tenant_id = $1, status = 'pending',
                  mqtt_username = $2, mqtt_password_hash = $3,
                  assigned_at = NULL,
                  claim_code = COALESCE(claim_code, $5)
            WHERE mqtt_device_id = $4`,
          [db.SYSTEM_TENANT_ID, username, _bootstrapHash, mqttDeviceId, claimCode]
        );
        // Clean up RBAC assignments (device will be re-assigned by admin)
        await db.query(
          `DELETE FROM user_devices WHERE device_id = (
             SELECT id FROM devices WHERE mqtt_device_id = $1
           )`, [mqttDeviceId]
        );
        mqttSvc.removeDeviceState(mqttDeviceId);
        await mqttSvc.refreshRegistries();

        logger.info({ device_id: mqttDeviceId },
          'Active device re-registered — reset to pending with bootstrap creds');

        return res.json({
          data: {
            device_id: mqttDeviceId,
            username,
            broker: process.env.MQTT_PUBLIC_HOST || 'modesp.com.ua',
            port: 8883,
            prefix: `modesp/v1/pending/${mqttDeviceId}`,
            status: 'pending',
            created: false,
            reset: true,
          },
        });
      }
      // Exists but no credentials — set bootstrap creds below
    } else {
      // Create new pending device in SYSTEM tenant
      await db.query(
        `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code)
         VALUES ($1, $2, 'pending', false, $3)`,
        [db.SYSTEM_TENANT_ID, mqttDeviceId, claimCode]
      );
    }

    // Set bootstrap credentials
    await db.query(
      `UPDATE devices SET mqtt_username = $1, mqtt_password_hash = $2
       WHERE mqtt_device_id = $3`,
      [username, _bootstrapHash, mqttDeviceId]
    );

    // Refresh in-memory registries so MQTT service recognizes the device
    await mqttSvc.refreshRegistries();

    const tenantSlug = existing.rows.length > 0 && existing.rows[0].status === 'active'
      ? undefined  // active device keeps its tenant prefix
      : 'pending';

    res.status(201).json({
      data: {
        device_id: mqttDeviceId,
        username,
        broker: process.env.MQTT_PUBLIC_HOST || 'modesp.com.ua',
        port: 8883,
        prefix: `modesp/v1/${tenantSlug || 'pending'}/${mqttDeviceId}`,
        status: 'pending',
        created: true,
      },
    });

    logger.info({ device_id: mqttDeviceId }, 'Device self-registered');
  } catch (err) {
    // Handle duplicate key race condition
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'conflict',
        message: `Device ${mqttDeviceId} registration in progress`,
        status: 409,
      });
    }
    logger.error({ err, device_id: mqttDeviceId }, 'Device registration failed');
    res.status(500).json({
      error: 'internal_error',
      message: 'Registration failed',
      status: 500,
    });
  }
});

// ── Firmware binary download (signed URLs — no JWT, ESP32 downloads directly) ──
app.get('/api/firmware/dl', require('./routes/firmware-download'));

// ── Audit middleware (before auth — captures login/logout too) ─────
app.use('/api', createAuditMiddleware(logger));

// ── Public site status page — intentionally UNAUTHENTICATED ────────
// Express runs middleware in registration order: this MUST stay above
// `app.use('/api', authenticate)`. test/public-site.test.js guards that twice —
// a supertest proves the router answers without an Authorization header, and a
// second case reads THIS file and asserts the mount below still precedes the JWT
// gate — so a future reorder fails a test instead of 401ing every status page.
// The raw token travels in the X-Site-Token header, never in the path (access.log).
app.use('/api/public', publicLimiter, publicRoutes);

// ── Auth / Tenant middleware ────────────────────────────────
if (AUTH_ENABLED) {
  // Public auth routes (no JWT required)
  // Rate limit login only — refresh fires automatically and shouldn't count
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/forgot-password', resetLimiter);
  app.use('/api/auth/reset-password', resetLimiter);
  app.use('/api/auth/invite', inviteLimiter);
  app.use('/api/auth', require('./routes/auth'));

  // All other /api routes require JWT
  app.use('/api', authenticate);

  // One-time WS ticket (P1-4) — issued over authenticated REST so the JWT
  // never travels in the WS URL query string (logs/Referer leak).
  app.get('/api/ws-ticket', (req, res) => {
    res.json({ data: { ticket: wsSvc.issueWsTicket(req.user) } });
  });

  // Own profile (any authenticated role) — must stay ABOVE the admin-only
  // /api/users mount, which would 403 a technician editing their home base.
  app.use('/api/profile',  require('./routes/profile'));

  // Admin-only routes (superadmin inherits admin via authorize)
  app.use('/api/tenants',  authorize('admin'), require('./routes/tenants'));
  app.use('/api/users',    authorize('admin'), require('./routes/users'));
  app.use('/api/firmware', require('./routes/firmware'));
  app.use('/api/ota',      require('./routes/ota'));
  app.use('/api/audit-log', requireSuperadmin, require('./routes/audit'));
  app.use('/api/pilot-requests', requireSuperadmin, require('./routes/pilot-requests'));
} else {
  // Dev fallback: tenant from header
  app.use('/api', tenantMw);
}

// ── Routes ─────────────────────────────────────────────
app.use('/api/devices',  require('./routes/devices'));
app.use('/api/devices',  require('./routes/telemetry'));  // /:id/telemetry
app.use('/api/alarms',   require('./routes/alarms'));     // /alarms
app.use('/api/devices',  require('./routes/alarms'));     // /:id/alarms
app.use('/api/devices',  require('./routes/events'));     // /:id/events
const { deviceRouter: exportDevices, alarmRouter: exportAlarms, siteRouter: exportSites } = require('./routes/export');
app.use('/api/devices',  exportDevices);                  // /:id/telemetry/export.csv|pdf, /export.csv
app.use('/api/alarms',   exportAlarms);                   // /export.csv
app.use('/api/sites',    exportSites);                    // /:id/export.pdf (HACCP, whole site)
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/fleet',    require('./routes/fleet'));
app.use('/api/device-models', require('./routes/device-models'));

// Per-user throttle on every route that can reach a third-party API.
// Registered before the routers below so it runs first.
app.use('/api/geo',                   externalLimiter);
app.use('/api/map/route',             externalLimiter);
app.use('/api/map/isochrones',        externalLimiter);
app.use('/api/sites/:id/weather',     externalLimiter);
app.use('/api/sites/geocode-pending', externalLimiter);

app.use('/api/sites',    require('./routes/sites'));       // trade points (торгові точки)
app.use('/api/geo',      require('./routes/geo'));         // geocoder proxy
app.use('/api/map',      require('./routes/map'));         // GeoJSON fleet map + filters
app.use('/api/stats',    require('./routes/geo-stats'));   // /geo aggregates

// Firmware/OTA routes (admin-only when AUTH_ENABLED, mounted above; dev fallback below)
if (!AUTH_ENABLED) {
  app.use('/api/firmware', require('./routes/firmware'));
  app.use('/api/ota',      require('./routes/ota'));
}

// ── Serve WebUI static files (production) ─────────────────
const webUiDist = path.join(__dirname, '../../webui/dist');
app.use(express.static(webUiDist));
// SPA fallback: non-API routes → index.html
app.get(/^\/(?!api|ws|firmware).*/, (_req, res) => {
  res.sendFile(path.join(webUiDist, 'index.html'));
});

// ── Global error handler ──────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled Express error');
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong', status: 500 });
});

// ── Bootstrap ───────────────────────────────────────────
async function main() {
  // 1. DB
  db.init(logger);
  try {
    await db.query('SELECT 1');
    logger.info('DB connected');
  } catch (err) {
    logger.fatal({ err }, 'Cannot connect to DB — exiting');
    process.exit(1);
  }

  // 2. MQTT
  await mqttSvc.start(logger);

  // 3. WebSocket
  wsSvc.attach(server, logger);

  // 4. Push notifications (Telegram + FCM + Web Push + Email)
  const tgHandler    = telegramSvc.init(logger);
  const fcmHandler   = fcmSvc.init(logger);
  const wpHandler    = webpushSvc.init(logger);
  const emailHandler = emailSvc.init(logger);
  if (tgHandler)    pushSvc.registerChannel('telegram', tgHandler);
  if (fcmHandler)   pushSvc.registerChannel('fcm', fcmHandler);
  if (wpHandler)    pushSvc.registerChannel('webpush', wpHandler);
  if (emailHandler) pushSvc.registerChannel('email', emailHandler);
  pushSvc.start(logger);

  // 5. OTA service (periodic status checker + rollout scheduler)
  otaSvc.start(logger);

  // 6. Geo services (geocode queue + cache sweeper, outdoor weather poller)
  geocodeSvc.start(logger);
  routingSvc.init(logger);
  weatherSvc.start(logger);

  // 7. HTTP
  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    logger.info({ port: PORT, host: HOST, auth: AUTH_ENABLED }, 'HTTP server listening');
  });
}

// ── Graceful shutdown ─────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  await Promise.allSettled([
    otaSvc.shutdown(),
    weatherSvc.shutdown(),
    geocodeSvc.shutdown(),
    pushSvc.shutdown(),
    telegramSvc.shutdown(),
    fcmSvc.shutdown(),
    webpushSvc.shutdown(),
    emailSvc.shutdown(),
    wsSvc.shutdown(),
  ]);
  await mqttSvc.shutdown();
  await db.shutdown();
  await new Promise(resolve => server.close(resolve));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch(err => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});

// Export for WebSocket attachment in ws.js
module.exports = { app, server };
