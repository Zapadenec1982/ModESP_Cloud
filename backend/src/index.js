'use strict';

require('dotenv').config();

const express  = require('express');
const pino     = require('pino');
const db       = require('./services/db');
const mqttSvc  = require('./services/mqtt');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

// ── Express ───────────────────────────────────────────────
const app = express();

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

// Global error handler
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

  // 3. HTTP (listen on localhost only — behind Nginx)
  app.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'HTTP server listening');
  });
}

// ── Graceful shutdown ─────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  await mqttSvc.shutdown();
  await db.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch(err => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
