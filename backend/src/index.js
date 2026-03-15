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
const otaSvc      = require('./services/ota');
const tenantMw    = require('./middleware/tenant');
const { authenticate, authorize, requireSuperadmin } = require('./middleware/auth');
const createAuditMiddleware = require('./middleware/audit');

const { timingSafeEqual } = require('crypto');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

// ── Security guards ──────────────────────────────────────
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

// ── Express ───────────────────────────────────────────────
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
  contentSecurityPolicy: false, // CSP handled by Nginx in production
  crossOriginEmbedderPolicy: false, // Allow loading firmware binaries
}));

// Rate limiting — auth & registration endpoints
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 50,                    // 50 attempts per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts, try again later', status: 429 },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,                    // 30 per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many registration attempts', status: 429 },
});

// ── Health check (no auth / no tenant) ────────────────────
app.get('/api/health', async (_req, res) => {
  const dbOk   = await db.healthy();
  const mqttOk = mqttSvc.isConnected();
  const status  = dbOk && mqttOk ? 'ok' : 'degraded';
  const code    = status === 'ok' ? 200 : 503;

  res.status(code).json({
    status,
    db:     dbOk   ? 'ok' : 'error',
    mqtt:   mqttOk ? 'ok' : 'error',
    uptime: Math.floor(process.uptime()),
  });
});

// ── Parameter metadata (no auth — same for all devices) ──────────
const stateMeta = require('./config/state_meta.json');
app.get('/api/meta', (_req, res) => {
  res.json(stateMeta);
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

  try {
    // Lazy-compute bootstrap hash (once, cached for process lifetime)
    if (!_bootstrapHash) {
      _bootstrapHash = await bcrypt.hash(bootstrapKey, 12);
    }

    // Check if device already exists
    const existing = await db.query(
      `SELECT mqtt_device_id, mqtt_username,
              (mqtt_password_hash IS NOT NULL) AS has_creds, status
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
        // Active device re-registering → it lost its provisioned credentials.
        // Reset to pending with bootstrap creds so it can reconnect.
        await db.query(
          `UPDATE devices
              SET tenant_id = $1, status = 'pending',
                  mqtt_username = $2, mqtt_password_hash = $3
            WHERE mqtt_device_id = $4`,
          [db.SYSTEM_TENANT_ID, username, _bootstrapHash, mqttDeviceId]
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
        `INSERT INTO devices (tenant_id, mqtt_device_id, status, online)
         VALUES ($1, $2, 'pending', false)`,
        [db.SYSTEM_TENANT_ID, mqttDeviceId]
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

// ── Firmware binary download (no auth — ESP32 downloads directly) ───
const firmwareDir = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../firmware');
app.use('/firmware', express.static(firmwareDir, { dotfiles: 'deny', index: false }));

// ── Audit middleware (before auth — captures login/logout too) ─────
app.use('/api', createAuditMiddleware(logger));

// ── Auth / Tenant middleware ────────────────────────────────
if (AUTH_ENABLED) {
  // Public auth routes (no JWT required)
  // Rate limit login only — refresh fires automatically and shouldn't count
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth', require('./routes/auth'));

  // All other /api routes require JWT
  app.use('/api', authenticate);

  // Admin-only routes (superadmin inherits admin via authorize)
  app.use('/api/tenants',  authorize('admin'), require('./routes/tenants'));
  app.use('/api/users',    authorize('admin'), require('./routes/users'));
  app.use('/api/firmware', require('./routes/firmware'));
  app.use('/api/ota',      require('./routes/ota'));
  app.use('/api/audit-log', requireSuperadmin, require('./routes/audit'));
} else {
  // Dev fallback: tenant from header
  app.use('/api', tenantMw);
}

// ── Routes ────────────────────────────────────────────────
app.use('/api/devices',  require('./routes/devices'));
app.use('/api/devices',  require('./routes/telemetry'));  // /:id/telemetry
app.use('/api/alarms',   require('./routes/alarms'));     // /alarms
app.use('/api/devices',  require('./routes/alarms'));     // /:id/alarms
app.use('/api/devices',  require('./routes/events'));     // /:id/events
const { deviceRouter: exportDevices, alarmRouter: exportAlarms } = require('./routes/export');
app.use('/api/devices',  exportDevices);                  // /:id/telemetry/export.csv|pdf, /export.csv
app.use('/api/alarms',   exportAlarms);                   // /export.csv
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/fleet',    require('./routes/fleet'));

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

// ── Bootstrap ─────────────────────────────────────────────
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

  // 4. Push notifications (Telegram + FCM + Web Push)
  const tgHandler  = telegramSvc.init(logger);
  const fcmHandler = fcmSvc.init(logger);
  const wpHandler  = webpushSvc.init(logger);
  if (tgHandler)  pushSvc.registerChannel('telegram', tgHandler);
  if (fcmHandler) pushSvc.registerChannel('fcm', fcmHandler);
  if (wpHandler)  pushSvc.registerChannel('webpush', wpHandler);
  pushSvc.start(logger);

  // 5. OTA service (periodic status checker + rollout scheduler)
  otaSvc.start(logger);

  // 6. HTTP
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
    pushSvc.shutdown(),
    telegramSvc.shutdown(),
    fcmSvc.shutdown(),
    webpushSvc.shutdown(),
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
