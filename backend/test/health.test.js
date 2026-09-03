'use strict';

// globals: true in vitest.config.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const platform = require('../src/services/platform-health');

const app = createTestApp();

afterAll(async () => {
  await shutdownDb();
});

describe('GET /api/health', () => {
  let tenant, admin, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant     = await createTenant({ slug: 'health-test' });
    admin      = await createUser(tenant.id, { role: 'admin' });
    superadmin = await createUser(tenant.id, { role: 'superadmin' });
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('is public and carries the categorical platform checks', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.mqtt).toBe('ok');
    expect(['ok', 'attention', 'unknown']).toContain(res.body.platform);
    expect(Object.keys(res.body.checks).sort()).toEqual(['backup', 'disk', 'partitions']);
    // The test DB has a DEFAULT partition, which counts as coverage
    expect(res.body.checks.partitions).toBe('ok');
    // Nothing numeric leaks on the public endpoint
    expect(JSON.stringify(res.body)).not.toMatch(/bytes|age_hours|free_pct/);
  });

  it('/details is superadmin-only', async () => {
    expect((await request(app).get('/api/health/details')).status).toBe(401);
    expect((await request(app).get('/api/health/details').set(authHeader(admin, tenant.id))).status).toBe(403);

    const res = await request(app).get('/api/health/details').set(authHeader(superadmin, tenant.id));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.db.ok).toBe(true);
    expect(d.mqtt).toHaveProperty('broker');
    expect(d.backup).toHaveProperty('status');
    expect(d.partitions.has_default).toBe(true);
    expect(typeof d.disk.free_pct === 'number' || d.disk.status === 'unknown').toBe(true);
    expect(d.channels).toHaveProperty('telegram_bot');
  });
});

describe('platform-health checks', () => {
  const query = (sql, params) => db.query(sql, params);
  let dir;

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modesp-health-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); platform.resetCache(); });

  function writeMarker(ts) {
    fs.writeFileSync(path.join(dir, 'last-success'),
      `timestamp=${ts}\narchive=modesp_backup_x.tar\narchive_bytes=1000\ndb_size_bytes=2000\noffsite=no\n`);
  }

  it('backup: fresh marker → ok, old marker → stale, no marker → unknown', async () => {
    const now = new Date('2026-09-02T12:00:00Z');
    expect((await platform.backupCheck({ now, backupDir: dir })).status).toBe('unknown');

    writeMarker('2026-09-02T02:00:00Z');
    const fresh = await platform.backupCheck({ now, backupDir: dir });
    expect(fresh.status).toBe('ok');
    expect(fresh.age_hours).toBe(10);
    expect(fresh.db_size_bytes).toBe(2000);

    writeMarker('2026-08-30T02:00:00Z');
    const old = await platform.backupCheck({ now, backupDir: dir });
    expect(old.status).toBe('stale');
    expect(old.age_hours).toBeGreaterThan(48);

    fs.writeFileSync(path.join(dir, 'last-success'), 'garbage');
    expect((await platform.backupCheck({ now, backupDir: dir })).status).toBe('unknown');
  });

  it('partitions: months ahead come from the partition names; DEFAULT counts as coverage', async () => {
    const now = new Date();
    const base = await platform.partitionCheck({ now, query });
    expect(base.has_default).toBe(true);
    expect(base.status).toBe('ok');

    const ahead = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    await db.query('SELECT create_telemetry_partition($1, $2)', [ahead.getFullYear(), ahead.getMonth() + 1]);
    try {
      const r = await platform.partitionCheck({ now, query });
      expect(r.ahead_months).toBe(3);
      expect(r.last_partition).toBe(`telemetry_${ahead.getFullYear()}_${String(ahead.getMonth() + 1).padStart(2, '0')}`);
      expect(r.status).toBe('ok');
    } finally {
      await db.query(`DROP TABLE IF EXISTS telemetry_${ahead.getFullYear()}_${String(ahead.getMonth() + 1).padStart(2, '0')}`);
    }
  });

  it('partitions: a query failure reports unknown instead of throwing', async () => {
    const r = await platform.partitionCheck({ query: async () => { throw new Error('boom'); } });
    expect(r.status).toBe('unknown');
    expect(r.error).toBe('boom');
  });

  it('disk: reports free space for a real path and falls back to the parent for a missing one', async () => {
    const real = await platform.diskCheck({ diskPath: dir });
    expect(real.status === 'ok' || real.status === 'low').toBe(true);
    expect(real.free_pct).toBeGreaterThanOrEqual(0);
    expect(real.free_pct).toBeLessThanOrEqual(100);

    const missing = await platform.diskCheck({ diskPath: path.join(dir, 'nope', 'firmware') });
    expect(missing.path).toBe(path.join(dir, 'nope'));
  });

  it('summarize: any stale/low check turns platform to attention', () => {
    const ok = platform.summarize({ backup: { status: 'ok' }, partitions: { status: 'ok' }, disk: { status: 'unknown' } });
    expect(ok.platform).toBe('ok');
    const bad = platform.summarize({ backup: { status: 'stale' }, partitions: { status: 'ok' }, disk: { status: 'ok' } });
    expect(bad).toEqual({ platform: 'attention', checks: { backup: 'stale', partitions: 'ok', disk: 'ok' } });
    expect(platform.summarize(null).platform).toBe('unknown');
  });
});
