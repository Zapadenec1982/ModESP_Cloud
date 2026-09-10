'use strict';

// globals: true in vitest.config.js
//
// Endpoints the suite never touched.
//
// The integrity audit counted twelve; walking the mounted routes against the
// test sources found fourteen. This file covers the ones reachable from the
// shared test app: the device event log and the two CSV exports — the evidence
// a HACCP inspector is handed — plus pausing a rollout.
//
// Two remain uncovered on purpose, and both for the same reason: they are
// declared straight on `app` in src/index.js rather than in a router, so no test
// app can mount them. POST /api/devices/register is the important one — every
// controller's entry point, bootstrap-key authentication and a replay window —
// and making it testable means lifting ~190 lines out of index.js into a router
// of its own. That is a refactor of a security path and belongs in its own
// change, not smuggled into a test PR.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, createFirmware, authHeader } = require('./helpers/factories');

const app = createTestApp();
// a custom .parse() puts the body in res.body, not res.text
const collect = (res) => String(res.body);

afterAll(async () => { await shutdownDb(); });

describe('Endpoints the suite used to leave alone', () => {
  let tenant, other, admin, viewer, adminOther, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'surface-a' });
    other  = await createTenant({ slug: 'surface-b' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@surface.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@surface.test' });
    adminOther = await createUser(other.id, { role: 'admin', email: 'admin@surface-b.test' });
    device = await createDevice(tenant.id, { mqttId: 'SURF01', name: 'Камера' });

    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, time) VALUES
         ($1, 'SURF01', 'compressor_on',  now() - interval '2 hours'),
         ($1, 'SURF01', 'compressor_off', now() - interval '1 hour'),
         ($1, 'SURF01', 'defrost_start',  now() - interval '30 minutes')`,
      [tenant.id]);
    await db.query(
      `INSERT INTO telemetry (tenant_id, device_id, channel, value, time) VALUES
         ($1, 'SURF01', 'air', -18.2, now() - interval '2 hours'),
         ($1, 'SURF01', 'air', -17.9, now() - interval '1 hour')`,
      [tenant.id]);
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, 'SURF01', 'high_temp_alarm', 'critical', false, now() - interval '3 hours', now() - interval '2 hours')`,
      [tenant.id]);
  });

  // ── GET /api/devices/:id/events ──────────────────────────
  it('the device event log reads newest first, pages, and stops at the organisation', async () => {
    const res = await request(app).get('/api/devices/SURF01/events').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.map(e => e.event_type)).toEqual(['defrost_start', 'compressor_off', 'compressor_on']);

    const page = await request(app).get('/api/devices/SURF01/events?limit=1&offset=1').set(authHeader(admin, tenant.id));
    expect(page.body.data.map(e => e.event_type)).toEqual(['compressor_off']);

    // by UUID as well as by controller id
    expect((await request(app).get(`/api/devices/${device.id}/events`).set(authHeader(admin, tenant.id))).body.data).toHaveLength(3);

    // another organisation cannot read them
    expect((await request(app).get('/api/devices/SURF01/events').set(authHeader(adminOther, other.id))).status).toBe(404);
  });

  // ── GET /api/devices/:id/telemetry/export.csv ────────────
  it('the telemetry CSV carries the BOM Excel needs and the rows of the period', async () => {
    const res = await request(app)
      .get('/api/devices/SURF01/telemetry/export.csv?channel=air')
      .set(authHeader(admin, tenant.id))
      .buffer(true).parse((r, cb) => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => cb(null, d)); });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(collect(res).charCodeAt(0)).toBe(0xFEFF);   // UTF-8 BOM
    expect(collect(res)).toContain('-18.2');
  });

  // ── GET /api/alarms/export.csv ───────────────────────────
  it('the alarm CSV carries the organisation\'s alarms, and a viewer with no grants gets only the header', async () => {
    const csv = (user) => request(app)
      .get('/api/alarms/export.csv')
      .set(authHeader(user, tenant.id))
      .buffer(true).parse((r, cb) => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => cb(null, d)); });

    const asAdmin = await csv(admin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.headers['content-type']).toMatch(/text\/csv/);
    expect(collect(asAdmin)).toContain('high_temp_alarm');

    // A viewer holds no user_devices and no user_sites, so the export is the
    // header alone — «empty list means nothing», the rule the whole access layer
    // is built on, reaching all the way into the CSV.
    const asViewer = await csv(viewer);
    expect(asViewer.status).toBe(200);
    expect(collect(asViewer)).not.toContain('high_temp_alarm');
  });

  // ── POST /api/ota/rollouts/:id/pause ─────────────────────
  it('a rollout can be paused by an administrator', async () => {
    const firmware = await createFirmware(tenant.id, { version: '9.9.9-surface' });
    const { rows: [rollout] } = await db.query(
      `INSERT INTO ota_rollouts (tenant_id, firmware_id, firmware_version, batch_size, batch_interval_s,
                                 fail_threshold_pct, status, total_devices)
       VALUES ($1, $2, '9.9.9-surface', 5, 300, 50, 'running', 1) RETURNING id`,
      [tenant.id, firmware.id]);

    const res = await request(app).post(`/api/ota/rollouts/${rollout.id}/pause`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paused');

    expect((await request(app).post(`/api/ota/rollouts/${rollout.id}/pause`).set(authHeader(viewer, tenant.id))).status).toBe(403);
  });
});
