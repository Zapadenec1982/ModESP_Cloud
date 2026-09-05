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
mqttSvc.setPendingTenantHint = () => {};
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

// Stub the third-party geo services. All three already read as disabled with no
// env set, so this is belt-and-braces: routes/devices.js now requires geocode
// for the CSV-import site backfill, and a CI box that happens to export
// GEOCODER_* / WEATHER_PROVIDER / OSRM_URL would otherwise make the device
// suites hit Nominatim, Open-Meteo or OSRM for real.
const geocodeSvc = require('../../src/services/geocode');
geocodeSvc.isEnabled = () => false;
geocodeSvc.isBulkEnabled = () => false;
geocodeSvc.search = async () => [];
geocodeSvc.reverse = async () => null;
geocodeSvc.geocode = async () => null;
geocodeSvc.resolveAddress = async () => ({ status: geocodeSvc.OUTCOME.DISABLED, result: null });

const weatherSvc = require('../../src/services/weather');
weatherSvc.isEnabled = () => false;
weatherSvc.timezoneFor = async () => null;
weatherSvc.siteWeather = async () => null;

const routingSvc = require('../../src/services/routing');
routingSvc.isEnabled = () => false;
routingSvc.isochronesEnabled = () => false;

const express = require('express');
const pino = require('pino');
const { authenticate, authorize, requireSuperadmin } = require('../../src/middleware/auth');
const createAuditMiddleware = require('../../src/middleware/audit');

const silentLogger = pino({ level: 'silent' });

function createTestApp() {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  // Firmware download (signed URLs, no auth — before audit/auth)
  app.get('/api/firmware/dl', require('../../src/routes/firmware-download'));

  // Audit middleware (before auth — captures login/logout too)
  app.use('/api', createAuditMiddleware(silentLogger));

  // Auth routes (public)
  app.use('/api/auth', require('../../src/routes/auth'));

  // Health: public summary + superadmin details, above the JWT gate as in index.js
  app.use('/api/health', require('../../src/routes/health'));

  // Public site status page — UNAUTHENTICATED by design, and therefore mounted
  // in the same position it holds in src/index.js: above the JWT gate. Kept here
  // so any suite using this helper exercises the real order; public-site.test.js
  // asserts it answers without an Authorization header.
  app.use('/api/public', require('../../src/routes/public'));

  // JWT gate
  app.use('/api', authenticate);

  // Own profile (any role) — ABOVE the admin-only /api/users mount, as in index.js
  app.use('/api/profile',  require('../../src/routes/profile'));

  // Admin-only routes
  app.use('/api/tenants',  authorize('admin'), require('../../src/routes/tenants'));
  app.use('/api/users',    authorize('admin'), require('../../src/routes/users'));

  // Admin-only routes (continued)
  app.use('/api/firmware', authorize('admin'), require('../../src/routes/firmware'));
  app.use('/api/ota',      authorize('admin'), require('../../src/routes/ota'));

  // Superadmin-only
  app.use('/api/audit-log', requireSuperadmin, require('../../src/routes/audit'));
  app.use('/api/pilot-requests', requireSuperadmin, require('../../src/routes/pilot-requests'));

  // Routes that all authed users can access
  app.use('/api/devices', require('../../src/routes/devices'));
  app.use('/api/devices', require('../../src/routes/telemetry'));
  app.use('/api/alarms',  require('../../src/routes/alarms'));
  app.use('/api/devices', require('../../src/routes/alarms'));
  const maintenanceRoutes = require('../../src/routes/maintenance');
  app.use('/api/maintenance', maintenanceRoutes.router);
  app.use('/api/devices',     maintenanceRoutes.deviceRouter);
  const workOrderRoutes = require('../../src/routes/work-orders');
  app.use('/api/work-orders', workOrderRoutes.router);
  app.use('/api/devices',     workOrderRoutes.deviceRouter);
  app.use('/api/devices', require('../../src/routes/events'));
  app.use('/api/notifications', require('../../src/routes/notifications'));
  app.use('/api/fleet',   require('../../src/routes/fleet'));
  // Sites and exports, mounted as index.js does (plan-limit and feature gates live there)
  app.use('/api/sites',   require('../../src/routes/sites'));
  const { deviceRouter: exportDevices, alarmRouter: exportAlarms, siteRouter: exportSites } = require('../../src/routes/export');
  app.use('/api/devices', exportDevices);
  app.use('/api/alarms',  exportAlarms);
  app.use('/api/sites',   exportSites);

  // Error handler
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });

  return app;
}

module.exports = { createTestApp };
