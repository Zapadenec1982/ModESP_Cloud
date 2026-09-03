'use strict';

// globals: true in vitest.config.js

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice } = require('./helpers/factories');
const purgeDemo = require('../src/scripts/purge-demo');

const query = (sql, params) => db.query(sql, params);
const transaction = (fn) => db.transaction(fn);
const noCsv = new Set();

describe('purge-demo (plan epic 1.10)', () => {
  let demo, real, demoDevice;

  beforeAll(async () => {
    await cleanDatabase();
    demo = await createTenant({ slug: 'demo-chain' });
    real = await createTenant({ slug: 'real-customer' });
    demoDevice = await createDevice(demo.id, { mqttId: 'EMU00001' });
    await db.query(`UPDATE devices SET firmware_version = '1.4.0-emu' WHERE id = $1`, [demoDevice.id]);
    await createDevice(real.id, { mqttId: 'REAL0001' });
    await createUser(demo.id, { role: 'admin', email: 'a@demo.test' });
    await createUser(real.id, { role: 'admin', email: 'a@real.test' });
    await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES (now(), $1, 'EMU00001', 'air', -18)`, [demo.id]);
    await db.query(`INSERT INTO telemetry_hourly VALUES ($1, 'EMU00001', 'air', date_trunc('hour', now()), -19, -17, -18, 12)`, [demo.id]);
    await db.query(`INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'EMU00001', 'high_temp_alarm', 'critical', true)`, [demo.id]);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('parses its arguments and rejects unknown ones', () => {
    expect(purgeDemo.parseArgs(['--tenant', 'a', '--keep', 'b', '--apply'])).toEqual({ tenants: ['a'], keep: ['b'], apply: true, help: false });
    expect(() => purgeDemo.parseArgs(['--tenant'])).toThrow(/needs a tenant slug/);
    expect(() => purgeDemo.parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });

  it('detects organisations that own emulator devices and never the system one', async () => {
    const found = await purgeDemo.findDemoTenants({ query, csvIds: noCsv });
    expect(found.map(t => t.slug)).toEqual(['demo-chain']);
    expect(found[0]).toMatchObject({ devices: 1, users: 1 });
    // ids from the emulator CSV count too
    const viaCsv = await purgeDemo.findDemoTenants({ query, csvIds: new Set(['REAL0001']) });
    expect(viaCsv.map(t => t.slug).sort()).toEqual(['demo-chain', 'real-customer']);
  });

  it('honours --keep and refuses an unknown --tenant', async () => {
    expect(await purgeDemo.findDemoTenants({ query, keep: ['demo-chain'], csvIds: noCsv })).toEqual([]);
    await expect(purgeDemo.findDemoTenants({ query, tenants: ['nope'] })).rejects.toThrow(/not found: nope/);
    expect((await purgeDemo.findDemoTenants({ query, tenants: ['real-customer'] })).map(t => t.slug)).toEqual(['real-customer']);
    expect(await purgeDemo.findDemoTenants({ query, tenants: ['__system__'] }).catch(e => e.message)).toMatch(/not found/);
  });

  it('a dry run deletes nothing', async () => {
    const r = await purgeDemo.purge({ query, transaction, apply: false, csvIds: noCsv });
    expect(r.targets.map(t => t.slug)).toEqual(['demo-chain']);
    expect(r.deleted).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [demo.id])).rows[0].n).toBe(1);
  });

  it('--apply drops the demo devices with their data and the organisation, leaving customers alone', async () => {
    const r = await purgeDemo.purge({ query, transaction, apply: true, csvIds: noCsv });
    expect(r.deleted).toHaveLength(1);
    expect(r.deleted[0]).toMatchObject({ slug: 'demo-chain', droppedDevices: 1, deletedTelemetry: 1, movedDevices: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [demo.id])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM devices WHERE mqtt_device_id = 'EMU00001'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM telemetry WHERE device_id = 'EMU00001'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM telemetry_hourly WHERE device_id = 'EMU00001'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1`, [demo.id])).rows[0].n).toBe(0);
    // the customer is untouched
    expect((await db.query(`SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1`, [real.id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1`, [real.id])).rows[0].n).toBe(1);
    // nothing left to find
    expect(await purgeDemo.findDemoTenants({ query, csvIds: noCsv })).toEqual([]);
  });
});
