'use strict';

require('dotenv').config();

const http     = require('http');
const express  = require('express');
const cors     = require('cors');
const pino     = require('pino');
const path        = require('path');
const db          = require('./services/db');
const mqttSvc     = require('./services/mqtt');
const wsSvc       = require('./services/ws');
const pushSvc     = require('./services/push');
const telegramSvc = require('./services/telegram');
const fcmSvc      = require('./services/fcm');
const otaSvc      = require('./services/ota');
const tenantMw    = require('./middleware/tenant');
const { authenticate, authorize } = require('./middleware/auth');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

// ── Express ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Body parsing
app.use(express.json());

// CORS (dev: Vite on 5173, prod: same-origin via Nginx)
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));

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

// ── Firmware binary download (no auth — ESP32 downloads directly) ───
const firmwareDir = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../firmware');
app.use('/firmware', express.static(firmwareDir));

// ── Auth / Tenant middleware ────────────────────────────────
if (AUTH_ENABLED) {
  // Public auth routes (no JWT required)
  app.use('/api/auth', require('./routes/auth'));

  // All other /api routes require JWT
  app.use('/api', authenticate);

  // Admin-only routes
  app.use('/api/users',    authorize('admin'), require('./routes/users'));
  app.use('/api/firmware', authorize('admin'), require('./routes/firmware'));
  app.use('/api/ota',      authorize('admin'), require('./routes/ota'));
} else {
  // Dev fallback: tenant from header
  app.use('/api', tenantMw);
}

// ── Routes ────────────────────────────────────────────────
app.use('/api/devices',  require('./routes/devices'));
app.use('/api/devices',  require('./routes/telemetry'));  // /:id/telemetry
app.use('/api/alarms',   require('./routes/alarms'));     // /alarms
app.use('/api/devices',  require('./routes/alarms'));     // /:id/alarms
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

  // 4. Push notifications (Telegram + FCM)
  const tgHandler  = telegramSvc.init(logger);
  const fcmHandler = fcmSvc.init(logger);
  if (tgHandler)  pushSvc.registerChannel('telegram', tgHandler);
  if (fcmHandler) pushSvc.registerChannel('fcm', fcmHandler);
  pushSvc.start(logger);

  // 5. OTA service (periodic status checker + rollout scheduler)
  otaSvc.start(logger);

  // 6. HTTP
  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, auth: AUTH_ENABLED }, 'HTTP server listening');
  });
}

// ── Graceful shutdown ─────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  otaSvc.shutdown();
  pushSvc.shutdown();
  telegramSvc.shutdown();
  fcmSvc.shutdown();
  wsSvc.shutdown();
  await mqttSvc.shutdown();
  await db.shutdown();
  server.close();
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
