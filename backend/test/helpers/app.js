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
mqttSvc.recordAssign = () => {};
mqttSvc.getBootstrapHash = () => '$2b$12$stubbedHashValue';
mqttSvc.requestFullState = () => {};
mqttSvc.updateDeviceStateMap = () => {};

// Stub mqtt-auth service
const mqttAuth = require('../../src/services/mqtt-auth');
mqttAuth.provisionDevice = async (_t, mqttId) => ({ username: `device_${mqttId}`, password: 'test-pass-123' });
mqttAuth.rotatePassword = async (_t, mqttId) => ({ username: `device_${mqttId}`, password: 'rotated-pass-456' });
mqttAuth.revokeCredentials = async () => {};

// Stub OTA service
const otaSvc = require('../../src/services/ota');
otaSvc.deploySingle = async (tenantId, slug, fwId, devId) => ({
  job_id: '00000000-0000-0000-0000-000000000099', device_id: devId,
  firmware_version: '1.0.0', status: 'sent',
});
otaSvc.createRollout = async () => ({
  rollout_id: '00000000-0000-0000-0000-000000000088', firmware_version: '1.0.0',
  total_devices: 2, skipped_incompatible: 0, batch_size: 5, batch_interval_s: 300, status: 'running',
});
otaSvc.pauseRollout = async () => ({ status: 'paused' });
otaSvc.resumeRollout = async () => ({ status: 'running' });
otaSvc.cancelRollout = async () => ({ status: 'cancelled' });

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

  // Admin-only routes (continued)
  app.use('/api/firmware', authorize('admin'), require('../../src/routes/firmware'));
  app.use('/api/ota',      authorize('admin'), require('../../src/routes/ota'));

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
