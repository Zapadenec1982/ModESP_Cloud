'use strict';

// setup.js sets env vars and inits DB
require('./setup');

// Stub MQTT service BEFORE routes are required (they import mqtt.js at require-time)
const mqttSvc = require('../../src/services/mqtt');
mqttSvc.refreshRegistries = async () => {};
mqttSvc.removeDeviceState = () => {};
mqttSvc.sendCommand = async () => {};
mqttSvc.sendJsonCommand = async () => {};
mqttSvc.clearPendingRetained = async () => {};
mqttSvc.isConnected = () => true;
mqttSvc.getDeviceState = () => null;
mqttSvc.getDeviceMeta = () => null;
mqttSvc.getDeviceRoutingSlug = () => 'test';

// Stub push service
const pushSvc = require('../../src/services/push');
pushSvc.testSend = async () => ({ ok: true, message: 'test stub' });

const express = require('express');
const pino = require('pino');
const { authenticate, authorize, requireSuperadmin } = require('../../src/middleware/auth');
const createAuditMiddleware = require('../../src/middleware/audit');

const silentLogger = pino({ level: 'silent' });

function createTestApp() {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  // Audit middleware (before auth — captures login/logout too)
  app.use('/api', createAuditMiddleware(silentLogger));

  // Auth routes (public)
  app.use('/api/auth', require('../../src/routes/auth'));

  // JWT gate
  app.use('/api', authenticate);

  // Admin-only routes
  app.use('/api/tenants',  authorize('admin'), require('../../src/routes/tenants'));
  app.use('/api/users',    authorize('admin'), require('../../src/routes/users'));

  // Superadmin-only
  app.use('/api/audit-log', requireSuperadmin, require('../../src/routes/audit'));

  // Routes that all authed users can access
  app.use('/api/devices', require('../../src/routes/devices'));
  app.use('/api/devices', require('../../src/routes/telemetry'));
  app.use('/api/alarms',  require('../../src/routes/alarms'));
  app.use('/api/devices', require('../../src/routes/alarms'));
  app.use('/api/notifications', require('../../src/routes/notifications'));
  app.use('/api/fleet',   require('../../src/routes/fleet'));

  // Error handler
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });

  return app;
}

module.exports = { createTestApp };
