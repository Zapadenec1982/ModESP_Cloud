'use strict';

// globals: true in vitest.config.js
//
// Migration 052 is not only a schema change — it repairs live data.
//
// Before it, the only way to say «this power profile is shared» was to put the
// model under the system organisation and point real organisations' devices at
// it. PR #57 then added `m.tenant_id = d.tenant_id` to every devices↔device_models
// join, which is right for a cross-CUSTOMER reference and wrong for that one: the
// model stopped matching, and devices whose own *_kw were empty lost their energy
// estimate outright.
//
// The migration turns such models into platform models (tenant_id NULL), which is
// what they were meant to be. This asserts the repair on the exact shape found in
// production: a system-tenant model, two organisations using it, and devices with
// no *_kw of their own.

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');

const SYSTEM_TENANT_ID = require('../src/services/db').SYSTEM_TENANT_ID;

afterAll(async () => { await shutdownDb(); });

/** The join every energy reader uses, post-052. */
const KW = `
  SELECT COALESCE(d.compressor_kw, m.compressor_kw, 0) AS kw
    FROM devices d
    LEFT JOIN device_models m ON m.id = d.model_id
                             AND (m.tenant_id IS NULL OR m.tenant_id = d.tenant_id)
   WHERE d.id = $1`;

describe('migration 052: a model parked under the system organisation', () => {
  let a, b, devA, devB, model;

  beforeAll(async () => {
    await cleanDatabase();
    a = await createTenant({ slug: 'plat-a' });
    b = await createTenant({ slug: 'plat-b' });

    // Recreate the pre-052 state: the migration has already run on this database,
    // so put the model back where it used to live.
    ({ rows: [model] } = await db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw)
       VALUES ($1, 'Prime (як у продакшні)', 2.2) RETURNING id`, [SYSTEM_TENANT_ID]));

    devA = await createDevice(a.id, { mqttId: 'PLATA1', name: 'Камера A' });
    devB = await createDevice(b.id, { mqttId: 'PLATB1', name: 'Камера B' });
    for (const d of [devA, devB]) {
      await db.query('UPDATE devices SET model_id = $1 WHERE id = $2', [model.id, d.id]);
    }
  });

  it('is invisible to the devices using it — the state that lost the estimate', async () => {
    for (const d of [devA, devB]) {
      const { rows } = await db.query(KW, [d.id]);
      expect(Number(rows[0].kw)).toBe(0);
    }
  });

  it('and the devices have no *_kw of their own to fall back to', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM devices
        WHERE id = ANY($1)
          AND COALESCE(compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw) IS NULL`,
      [[devA.id, devB.id]]);
    expect(rows[0].n).toBe(2);
  });

  it('what the migration does restores both organisations at once', async () => {
    // exactly the UPDATE in 052_platform_device_models.sql
    await db.query('UPDATE device_models SET tenant_id = NULL WHERE tenant_id = $1', [SYSTEM_TENANT_ID]);

    for (const d of [devA, devB]) {
      const { rows } = await db.query(KW, [d.id]);
      expect(Number(rows[0].kw)).toBe(2.2);
    }
  });

  it('the column really is nullable and platform names are unique', async () => {
    const { rows } = await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'device_models' AND column_name = 'tenant_id'`);
    expect(rows[0].is_nullable).toBe('YES');

    await expect(db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw) VALUES (NULL, 'Prime (як у продакшні)', 1)`
    )).rejects.toMatchObject({ code: '23505' });
  });
});
