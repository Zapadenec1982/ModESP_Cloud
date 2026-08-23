'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

// ── Local factories ───────────────────────────────────────
// sites / user_sites arrive with migration 021 and helpers/factories.js is shared
// with every other suite, so the geo fixtures live here.

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, city, latitude, longitude, geo_source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      tenantId,
      overrides.name || `Site ${Math.random().toString(16).slice(2, 10)}`,
      overrides.city ?? null,
      overrides.latitude ?? null,
      overrides.longitude ?? null,
      overrides.geo_source || 'none',
    ]
  );
  return rows[0];
}

async function grantSiteAccess(userId, site, grantedBy, tenantId) {
  await db.query(
    `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [userId, site.id, tenantId || site.tenant_id, grantedBy]
  );
}

async function revokeSiteAccess(userId, siteId) {
  await db.query('DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2', [userId, siteId]);
}

async function attachDeviceToSite(deviceId, siteId) {
  await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteId, deviceId]);
}

const idsOf = res => res.body.data.map(d => d.id).sort();

describe('Site-level RBAC (user_sites)', () => {
  let tenantA, tenantB;
  let admin, siteTech, deviceTech, bothTech, noGrantTech, crossTech;
  let siteKyiv, siteLviv, siteBrno;
  let devKyiv1, devKyiv2, devLviv, devLoose, devBrno;

  beforeAll(async () => {
    await cleanDatabase();

    tenantA = await createTenant({ slug: 'site-rbac-a' });
    tenantB = await createTenant({ slug: 'site-rbac-b' });

    admin       = await createUser(tenantA.id, { role: 'admin',      email: 'admin@site-rbac.test' });
    siteTech    = await createUser(tenantA.id, { role: 'technician', email: 'site@site-rbac.test' });
    deviceTech  = await createUser(tenantA.id, { role: 'technician', email: 'device@site-rbac.test' });
    bothTech    = await createUser(tenantA.id, { role: 'technician', email: 'both@site-rbac.test' });
    noGrantTech = await createUser(tenantA.id, { role: 'technician', email: 'none@site-rbac.test' });
    crossTech   = await createUser(tenantA.id, { role: 'technician', email: 'cross@site-rbac.test' });

    // crossTech works in both tenants (user_tenants / switch-tenant flow)
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [crossTech.id, tenantB.id]
    );

    siteKyiv = await createSite(tenantA.id, { name: 'АТБ №142', city: 'Київ' });
    siteLviv = await createSite(tenantA.id, { name: 'Сільпо №7', city: 'Львів' });
    siteBrno = await createSite(tenantB.id, { name: 'Foreign Site', city: 'Brno' });

    devKyiv1 = await createDevice(tenantA.id, { name: 'Kyiv cabinet 1' });
    devKyiv2 = await createDevice(tenantA.id, { name: 'Kyiv cabinet 2' });
    devLviv  = await createDevice(tenantA.id, { name: 'Lviv cabinet' });
    devLoose = await createDevice(tenantA.id, { name: 'No site cabinet' });
    devBrno  = await createDevice(tenantB.id, { name: 'Brno cabinet' });

    await attachDeviceToSite(devKyiv1.id, siteKyiv.id);
    await attachDeviceToSite(devKyiv2.id, siteKyiv.id);
    await attachDeviceToSite(devLviv.id,  siteLviv.id);
    await attachDeviceToSite(devBrno.id,  siteBrno.id);

    // siteTech: one site grant, nothing else
    await grantSiteAccess(siteTech.id, siteKyiv, admin.id);
    // deviceTech: the pre-existing per-device grant, unchanged
    await grantDeviceAccess(deviceTech.id, devLviv.id, admin.id);
    // bothTech: site grant + a per-device grant that overlaps it
    await grantSiteAccess(bothTech.id, siteKyiv, admin.id);
    await grantDeviceAccess(bothTech.id, devKyiv1.id, admin.id);
    await grantDeviceAccess(bothTech.id, devLoose.id, admin.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Site grants ─────────────────────────────────────────

  it('technician granted a site sees exactly that site devices and nothing else', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([devKyiv1.id, devKyiv2.id].sort());
  });

  it('site grant opens the single-device endpoints too (list/detail agree)', async () => {
    const res = await request(app)
      .get(`/api/devices/${devKyiv1.id}`)
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(devKyiv1.id);
  });

  it('site grant resolves a device by mqtt_device_id as well', async () => {
    const res = await request(app)
      .get(`/api/devices/${devKyiv2.mqtt_device_id}`)
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(devKyiv2.id);
  });

  it('a device on another site stays forbidden', async () => {
    const res = await request(app)
      .get(`/api/devices/${devLviv.id}`)
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('a device with no site stays forbidden', async () => {
    const res = await request(app)
      .get(`/api/devices/${devLoose.id}`)
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(403);
  });

  it('fleet summary counts only the granted site', async () => {
    const res = await request(app)
      .get('/api/fleet/summary')
      .set(authHeader(siteTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data.devices_total).toBe(2);
  });

  // ── Union with the existing per-device grants ────────────

  it('existing per-device grants still work unchanged', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(deviceTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([devLviv.id]);

    const detail = await request(app)
      .get(`/api/devices/${devLviv.id}`)
      .set(authHeader(deviceTech, tenantA.id));
    expect(detail.status).toBe(200);
  });

  it('a device grant alone never widens to the rest of its site', async () => {
    // devLviv belongs to siteLviv; deviceTech holds the device, not the site.
    const other = await createDevice(tenantA.id, { name: 'Lviv cabinet 2' });
    await attachDeviceToSite(other.id, siteLviv.id);

    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(deviceTech, tenantA.id));

    expect(idsOf(res)).toEqual([devLviv.id]);

    const detail = await request(app)
      .get(`/api/devices/${other.id}`)
      .set(authHeader(deviceTech, tenantA.id));
    expect(detail.status).toBe(403);
  });

  it('both grant kinds union without duplicating the overlapping device', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(bothTech, tenantA.id));

    expect(res.status).toBe(200);
    // devKyiv1 is granted twice (site + device) and must appear once
    expect(idsOf(res)).toEqual([devKyiv1.id, devKyiv2.id, devLoose.id].sort());
    expect(res.body.data.filter(d => d.id === devKyiv1.id)).toHaveLength(1);
  });

  // ── Revocation ──────────────────────────────────────────

  it('revoking a site grant removes access to its devices', async () => {
    const tech = await createUser(tenantA.id, { role: 'technician', email: 'revoke@site-rbac.test' });
    await grantSiteAccess(tech.id, siteKyiv, admin.id);

    const before = await request(app).get('/api/devices').set(authHeader(tech, tenantA.id));
    expect(idsOf(before)).toEqual([devKyiv1.id, devKyiv2.id].sort());

    await revokeSiteAccess(tech.id, siteKyiv.id);

    const after = await request(app).get('/api/devices').set(authHeader(tech, tenantA.id));
    expect(after.status).toBe(200);
    expect(after.body.data).toEqual([]);

    const detail = await request(app)
      .get(`/api/devices/${devKyiv1.id}`)
      .set(authHeader(tech, tenantA.id));
    expect(detail.status).toBe(403);
  });

  it('a user with zero grants sees nothing instead of the whole tenant', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(noGrantTech, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);

    const detail = await request(app)
      .get(`/api/devices/${devKyiv1.id}`)
      .set(authHeader(noGrantTech, tenantA.id));
    expect(detail.status).toBe(403);
  });

  // ── Tenant boundary ─────────────────────────────────────

  it('a site grant held in another tenant grants nothing while acting here', async () => {
    await grantSiteAccess(crossTech.id, siteBrno, admin.id, tenantB.id);

    const inA = await request(app)
      .get('/api/devices')
      .set(authHeader(crossTech, tenantA.id));
    expect(inA.status).toBe(200);
    expect(inA.body.data).toEqual([]);

    const foreignDetail = await request(app)
      .get(`/api/devices/${devBrno.id}`)
      .set(authHeader(crossTech, tenantA.id));
    expect(foreignDetail.status).toBe(403);

    // …while the same grant works in the tenant it was issued for
    const inB = await request(app)
      .get('/api/devices')
      .set(authHeader(crossTech, tenantB.id));
    expect(idsOf(inB)).toEqual([devBrno.id]);
  });

  it('a stale cross-tenant site_id on a device grants nothing', async () => {
    // devices.site_id has no composite FK on purpose (soft delete / reassign move
    // a device between tenants without touching site_id), so the middleware carries
    // s.tenant_id = d.tenant_id instead. Simulate the stale pointer.
    const stray = await createDevice(tenantA.id, { name: 'Stray cabinet' });
    await attachDeviceToSite(stray.id, siteBrno.id);   // tenant B site on a tenant A device

    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(crossTech, tenantA.id));
    expect(idsOf(res)).not.toContain(stray.id);

    const detail = await request(app)
      .get(`/api/devices/${stray.id}`)
      .set(authHeader(crossTech, tenantA.id));
    expect(detail.status).toBe(403);

    await db.query('UPDATE devices SET site_id = NULL WHERE id = $1', [stray.id]);
  });

  it('the database refuses a grant whose tenant does not own the site', async () => {
    const outsider = await createUser(tenantB.id, { role: 'technician', email: 'outsider@site-rbac.test' });

    let code = null;
    try {
      await db.query(
        `INSERT INTO user_sites (user_id, site_id, tenant_id) VALUES ($1, $2, $3)`,
        [outsider.id, siteKyiv.id, tenantB.id]   // tenant A site claimed under tenant B
      );
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe('23503');   // foreign_key_violation on (tenant_id, site_id)
  });

  // ── Admin bypass is untouched ───────────────────────────

  it('admin still bypasses both grant tables', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids).toContain(devKyiv1.id);
    expect(ids).toContain(devLviv.id);
    expect(ids).toContain(devLoose.id);
    expect(ids).not.toContain(devBrno.id);   // other tenant stays out
  });
});
