'use strict';

// globals: true in vitest.config.js
//
// The mosquitto ACL is SQL living in an infra config, not JavaScript, so there is no
// module to import and stub. These tests read the real `auth_opt_pg_aclquery` line out
// of infra/mosquitto/mosquitto.conf and run it against the test database with the same
// two bind parameters mosquitto-go-auth passes ($1 = mqtt_username, $2 = access level).
// That means the suite fails the moment the deployed query and the intent drift apart —
// which is the only way to test a widened ACL honestly.
//
// Subject under test: migration 022's self-closing grant. An ACTIVE device keeps
// modesp/v1/pending/<its own id> for exactly as long as it has not yet checked in under
// its own tenant prefix (last_seen IS NULL OR last_seen <= assigned_at).

const fs = require('fs');
const path = require('path');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant } = require('./helpers/factories');

// ── Load the ACL query straight from the deployed config ──
const CONF_PATH = path.join(__dirname, '../../infra/mosquitto/mosquitto.conf');
const CONF_TEXT = fs.readFileSync(CONF_PATH, 'utf8');
const ACL_LINES = CONF_TEXT.split(/\r?\n/).filter(l => l.startsWith('auth_opt_pg_aclquery'));
const ACL_SQL = (ACL_LINES[0] || '').replace(/^auth_opt_pg_aclquery\s+/, '');
const USER_LINES = CONF_TEXT.split(/\r?\n/).filter(l => l.startsWith('auth_opt_pg_userquery'));
const USER_SQL = (USER_LINES[0] || '').replace(/^auth_opt_pg_userquery\s+/, '');

// The deploy script used to carry its own frozen copy of these queries and overwrite the
// broker with it — silently reverting whatever this file proves. It must never hold one
// again; it installs the config above verbatim.
const DEPLOY_PATH = path.join(__dirname, '../scripts/deploy-mqtt-auth.sh');
const DEPLOY_TEXT = fs.readFileSync(DEPLOY_PATH, 'utf8');

// mosquitto 2.0 access levels, as passed in $2
const READ = 1;
const WRITE = 2;
const SUBSCRIBE = 4;

// The suffix/rw table the query CROSS JOINs against
const PUB_SUFFIXES = ['/state/+', '/status', '/heartbeat', '/backfill', '/backfill/events', '/backfill/done'];
const SUB_SUFFIXES = ['/cmd/+'];

function topics(prefix, suffixes) {
  return suffixes.map(s => prefix + s).sort();
}

/** Run the real ACL query the way the broker does. Returns the granted topics, sorted. */
async function acl(username, access) {
  const { rows } = await db.query(ACL_SQL, [username, access]);
  return rows.map(r => Object.values(r)[0]).sort();
}

/** Run the real user (authentication) query. Returns the hash the broker would compare. */
async function authHash(username) {
  const { rows } = await db.query(USER_SQL, [username]);
  return rows.length ? Object.values(rows[0])[0] : null;
}

const BOOTSTRAP_HASH = '$2b$12$acl.grace.suite.bootstrap.hash.placeholder';

let mqttSeq = 0;
function nextMqttId() {
  // 6 hex chars; devices.mqtt_device_id and .mqtt_username are both globally UNIQUE
  return `AC${(mqttSeq++).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Insert a device row directly — these tests are about what the SQL returns for a
 * given row shape, so they set status / last_seen / assigned_at explicitly rather
 * than going through the HTTP assign flow (that path is covered in devices.test.js).
 */
async function mkDevice({
  tenantId, status, lastSeen = null, assignedAt = null, deletedAt = null,
  passwordHash = null, mqttId = nextMqttId(),
}) {
  const { rows } = await db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, mqtt_username, status, online,
                          last_seen, assigned_at, deleted_at, mqtt_password_hash)
     VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8) RETURNING *`,
    [tenantId, mqttId, `device_${mqttId}`, status, lastSeen, assignedAt, deletedAt, passwordHash]
  );
  return rows[0];
}

describe('MQTT ACL — self-closing pending grant (migration 022)', () => {
  let tenantA, tenantB;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA = await createTenant({ slug: 'acl-grace-a' });
    tenantB = await createTenant({ slug: 'acl-grace-b' });
    // The userquery's priority-2 branch reads this singleton; without a row the
    // bootstrap-fallback assertions below could not tell "suppressed" from "absent".
    await db.query(
      `INSERT INTO mqtt_bootstrap (id, password_hash) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [BOOTSTRAP_HASH]
    );
  });

  afterAll(async () => {
    // mqtt_bootstrap is not in cleanDatabase's TRUNCATE list (it is a singleton config
    // row, not test data), so remove ours explicitly rather than leaking it to the next
    // suite. fileParallelism is off, so this ordering is deterministic.
    await db.query('DELETE FROM mqtt_bootstrap WHERE id = 1');
    await cleanDatabase();
    await shutdownDb();
  });

  // ── The config itself ───────────────────────────────────

  describe('the deployed config', () => {
    it('carries exactly one aclquery directive, on one physical line', () => {
      // mosquitto.conf has no line-continuation syntax: a wrapped query is a broken query.
      expect(ACL_LINES).toHaveLength(1);
      expect(ACL_SQL).not.toMatch(/[\r\n]/);
      expect(ACL_SQL.length).toBeGreaterThan(0);
    });

    it('contains the self-closing predicate and still binds only $1 and $2', () => {
      expect(ACL_SQL).toContain('d.last_seen IS NULL OR d.last_seen <= d.assigned_at');
      // The grant must require an explicit assign stamp — see the "never assigned"
      // case below and src/scripts/provision-demo-fleet.js.
      expect(ACL_SQL).toContain('d.assigned_at IS NOT NULL');
      // No parameter beyond $2 may appear — go-auth passes exactly two.
      expect(ACL_SQL).not.toMatch(/\$[3-9]/);
    });

    it('strips the device_ prefix with an ANCHORED expression, never a global REPLACE', () => {
      // REPLACE($1, 'device_', '') is global: 'device_device_ABC' collapses to 'ABC',
      // which let a holder of the shared bootstrap password claim any device's prefix.
      expect(ACL_SQL).not.toContain("REPLACE($1, 'device_', '')");
      expect(ACL_SQL).toContain("regexp_replace($1, '^device_', '')");
    });

    it('is the only copy in the repo — the deploy script installs it, never rewrites it', () => {
      expect(DEPLOY_TEXT).not.toMatch(/^\s*auth_opt_pg_aclquery\s/m);
      expect(DEPLOY_TEXT).not.toMatch(/^\s*auth_opt_pg_userquery\s/m);
      expect(DEPLOY_TEXT).toContain('infra/mosquitto/mosquitto.conf');
    });

    it('carries exactly one userquery, on one physical line, binding only $1', () => {
      expect(USER_LINES).toHaveLength(1);
      expect(USER_SQL).not.toMatch(/[\r\n]/);
      expect(USER_SQL).not.toMatch(/\$[2-9]/);
    });
  });

  // ── Authentication: what the broker will accept a password against ──

  describe('the user query', () => {
    it('returns the device\'s own hash, never the shared bootstrap one', async () => {
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
        passwordHash: '$2b$12$device.specific.hash',
      });

      expect(await authHash(d.mqtt_username)).toBe('$2b$12$device.specific.hash');
    });

    it('falls back to the bootstrap hash for a username with no row', async () => {
      expect(await authHash('device_FFFFF0')).toBe(BOOTSTRAP_HASH);
    });

    it('refuses a disabled device instead of handing it the bootstrap hash', async () => {
      // 'disabled' is an operator revocation. Priority 1 already excludes it; the
      // priority-2 guard must exclude it too, or revoking a device's own credentials
      // silently hands it the shared ones back.
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'disabled', passwordHash: '$2b$12$revoked.hash',
      });

      expect(await authHash(d.mqtt_username)).toBeNull();
    });
  });

  // ── The grant is CLOSED once the device has checked in ──

  describe('active device that has checked in under its own tenant', () => {
    it('is not granted the pending prefix (publish)', async () => {
      const now = new Date();
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: new Date(now.getTime() - 60_000),
        lastSeen: now, // checked in AFTER the assign → grant closed
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toEqual(topics(`modesp/v1/${tenantA.slug}/${d.mqtt_device_id}`, PUB_SUFFIXES));
      expect(granted.some(t => t.startsWith('modesp/v1/pending/'))).toBe(false);
    });

    it('is not granted the pending cmd topic (subscribe)', async () => {
      const now = new Date();
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: new Date(now.getTime() - 60_000),
        lastSeen: now,
      });

      const granted = await acl(d.mqtt_username, SUBSCRIBE);

      expect(granted).toEqual([`modesp/v1/${tenantA.slug}/${d.mqtt_device_id}/cmd/+`]);
    });
  });

  // ── The grant is OPEN while the device has never checked in ──

  describe('active device that never checked in — the deadlock case', () => {
    it('keeps the pending publish prefix when last_seen IS NULL', async () => {
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: new Date(),
        lastSeen: null, // assigned while offline, never seen since
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toEqual([
        ...topics(`modesp/v1/${tenantA.slug}/${d.mqtt_device_id}`, PUB_SUFFIXES),
        ...topics(`modesp/v1/pending/${d.mqtt_device_id}`, PUB_SUFFIXES),
      ].sort());
    });

    it('keeps the pending cmd topic so autoReassignDevice can actually reach it', async () => {
      // This is the whole point: checkStuckDevice -> autoReassignDevice publishes
      // _set_tenant (retained) to modesp/v1/pending/<id>/cmd/+. Without this grant the
      // device cannot subscribe there and the rescue is silently denied.
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: new Date(),
        lastSeen: null,
      });

      const granted = await acl(d.mqtt_username, SUBSCRIBE);

      expect(granted).toEqual([
        `modesp/v1/${tenantA.slug}/${d.mqtt_device_id}/cmd/+`,
        `modesp/v1/pending/${d.mqtt_device_id}/cmd/+`,
      ].sort());
    });

    it('keeps the grant when last_seen is stale (last_seen < assigned_at)', async () => {
      const now = new Date();
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: now,
        lastSeen: new Date(now.getTime() - 86_400_000), // last heard from a day before the assign
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toContain(`modesp/v1/pending/${d.mqtt_device_id}/status`);
    });

    it('keeps the grant at the boundary (last_seen == assigned_at)', async () => {
      // The predicate is <=, not <: a row stamped in the same transaction as its last
      // last_seen has not proved anything yet, so it must still count as "never checked in".
      const stamp = new Date();
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: stamp,
        lastSeen: stamp,
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toContain(`modesp/v1/pending/${d.mqtt_device_id}/status`);
    });

    it('does NOT grant an active row that never went through an assign', async () => {
      // assigned_at NULL + last_seen NULL. src/scripts/provision-demo-fleet.js writes
      // exactly this shape for the whole demo fleet, and re-writes it on every re-run.
      // Such a row was never on the pending prefix, so it has no deadlock to break; if
      // `last_seen IS NULL` alone were enough it would hold the grant open forever.
      const d = await mkDevice({ tenantId: tenantA.id, status: 'active' });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toEqual(topics(`modesp/v1/${tenantA.slug}/${d.mqtt_device_id}`, PUB_SUFFIXES));
      expect(granted.some(t => t.startsWith('modesp/v1/pending/'))).toBe(false);
    });

    it('does NOT grant when assigned_at is NULL but the device has been seen', async () => {
      // NULL comparison, pinned deliberately: last_seen <= NULL is NULL, so the branch
      // yields nothing. A device that has demonstrably published under its own tenant
      // never needs the pending prefix, with or without a stamp.
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: null,
        lastSeen: new Date(),
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted.some(t => t.startsWith('modesp/v1/pending/'))).toBe(false);
    });
  });

  // ── The other statuses must behave exactly as they did before ──

  describe('pending and deleted devices are unchanged', () => {
    it('a pending device gets the pending prefix and nothing else', async () => {
      const d = await mkDevice({ tenantId: db.SYSTEM_TENANT_ID, status: 'pending' });

      expect(await acl(d.mqtt_username, WRITE))
        .toEqual(topics(`modesp/v1/pending/${d.mqtt_device_id}`, PUB_SUFFIXES));
      expect(await acl(d.mqtt_username, SUBSCRIBE))
        .toEqual(topics(`modesp/v1/pending/${d.mqtt_device_id}`, SUB_SUFFIXES));
    });

    it('a pending device with a stale assigned_at does not get a duplicate branch', async () => {
      // Branch 3 is gated on status = 'active'; a leftover stamp must not fire it.
      const d = await mkDevice({
        tenantId: db.SYSTEM_TENANT_ID,
        status: 'pending',
        assignedAt: new Date(),
        lastSeen: null,
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toEqual(topics(`modesp/v1/pending/${d.mqtt_device_id}`, PUB_SUFFIXES));
      expect(new Set(granted).size).toBe(granted.length); // no duplicates
    });

    it('a deleted device gets the pending prefix and nothing else', async () => {
      const d = await mkDevice({
        tenantId: db.SYSTEM_TENANT_ID,
        status: 'deleted',
        assignedAt: new Date(),
        lastSeen: null,
      });

      expect(await acl(d.mqtt_username, WRITE))
        .toEqual(topics(`modesp/v1/pending/${d.mqtt_device_id}`, PUB_SUFFIXES));
    });

    it('an unknown username still falls back to the bootstrap pending namespace', async () => {
      const granted = await acl('device_FFFFFF', WRITE);

      expect(granted).toEqual(topics('modesp/v1/pending/FFFFFF', PUB_SUFFIXES));
    });

    it('an unknown username without the device_ prefix is granted nothing', async () => {
      // The bootstrap fallback is gated on $1 LIKE 'device_%'; a stray client that
      // somehow authenticated must not inherit a namespace.
      expect(await acl('backend-service', WRITE)).toEqual([]);
      expect(await acl('backend-service', SUBSCRIBE)).toEqual([]);
    });

    it('a soft-deleted row that still says active is not granted the pending prefix', async () => {
      // Both delete handlers write status and deleted_at together, so this shape should
      // not occur — but branch 3 keys on status, and public.js treats
      // `status = 'active' AND deleted_at IS NULL` as the real liveness predicate.
      // Branch 3 carries `d.deleted_at IS NULL` so the two notions cannot drift apart.
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'active',
        assignedAt: new Date(),
        lastSeen: null,
        deletedAt: new Date(),
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted.some(t => t.startsWith('modesp/v1/pending/'))).toBe(false);
    });

    it('a disabled device is granted nothing at any access level', async () => {
      // 'disabled' is an operator revocation. It must not fall through to the bootstrap
      // fallback branch, which would hand the device back the shared-credential pending
      // namespace — including cmd/+ — after its own credentials were revoked.
      const d = await mkDevice({
        tenantId: tenantA.id,
        status: 'disabled',
        assignedAt: new Date(),
        lastSeen: null,
      });

      for (const level of [READ, WRITE, SUBSCRIBE]) {
        expect(await acl(d.mqtt_username, level)).toEqual([]);
      }
    });

    it('an active row with no mqtt_username contributes nothing to anyone', async () => {
      const orphanId = nextMqttId();
      await db.query(
        `INSERT INTO devices (tenant_id, mqtt_device_id, mqtt_username, status, online, assigned_at)
         VALUES ($1, $2, NULL, 'active', false, NOW())`,
        [tenantA.id, orphanId]
      );

      const granted = await acl(`device_${orphanId}`, WRITE);

      // No row matches mqtt_username, so only the bootstrap fallback fires —
      // the credential-less active row never leaks a grant.
      expect(granted).toEqual(topics(`modesp/v1/pending/${orphanId}`, PUB_SUFFIXES));
    });
  });

  // ── Tenant isolation: the widened grant must stay inside one device ──

  describe('the grant can never reach another device or another tenant', () => {
    it('a stuck device is granted only its OWN pending prefix', async () => {
      const stuck = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });
      const neighbour = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });
      const foreign = await mkDevice({
        tenantId: tenantB.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      for (const level of [READ, WRITE, SUBSCRIBE]) {
        const granted = await acl(stuck.mqtt_username, level);

        expect(granted.every(t => t.includes(stuck.mqtt_device_id))).toBe(true);
        expect(granted.some(t => t.includes(neighbour.mqtt_device_id))).toBe(false);
        expect(granted.some(t => t.includes(foreign.mqtt_device_id))).toBe(false);
        expect(granted.some(t => t.includes(`/${tenantB.slug}/`))).toBe(false);
      }
    });

    it('a doubled device_ prefix cannot claim an existing device\'s pending namespace', async () => {
      // The bootstrap fallback strips 'device_' from $1. With an unanchored REPLACE it
      // stripped BOTH occurrences, so 'device_device_<id>' resolved to '<id>' — and
      // because no devices row carries the doubled username, the NOT EXISTS guard
      // passed and auth_opt_pg_userquery handed out the shared bootstrap hash. Anyone
      // holding MQTT_BOOTSTRAP_PASSWORD could then publish on any active device's
      // pending prefix, which drives checkStuckDevice against a device they do not own.
      const victim = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: new Date(),
      });

      for (const level of [READ, WRITE, SUBSCRIBE]) {
        // 'device_' + 'device_<id>' — the doubled form.
        const granted = await acl(`device_${victim.mqtt_username}`, level);
        expect(granted.some(t => t.startsWith(`modesp/v1/pending/${victim.mqtt_device_id}/`))).toBe(false);
        // Only the first prefix is stripped, so it lands in a namespace of its own.
        expect(granted.every(t => t.startsWith(`modesp/v1/pending/${victim.mqtt_username}/`))).toBe(true);
      }
    });

    it('the pending prefix is the SYSTEM namespace, never another tenant slug', async () => {
      const stuck = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      const granted = await acl(stuck.mqtt_username, WRITE);
      const prefixes = new Set(granted.map(t => t.split('/').slice(0, 4).join('/')));

      expect(prefixes).toEqual(new Set([
        `modesp/v1/${tenantA.slug}/${stuck.mqtt_device_id}`,
        `modesp/v1/pending/${stuck.mqtt_device_id}`,
      ]));
    });
  });

  // ── Access levels behave exactly as before ──────────────

  describe('read / publish / subscribe levels', () => {
    it('publish ($2 = 2) returns the six publish topics per prefix, never cmd/+', async () => {
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      const granted = await acl(d.mqtt_username, WRITE);

      expect(granted).toHaveLength(PUB_SUFFIXES.length * 2);
      expect(granted.some(t => t.endsWith('/cmd/+'))).toBe(false);
    });

    it('read ($2 = 1) returns cmd/+ only', async () => {
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      const granted = await acl(d.mqtt_username, READ);

      expect(granted).toEqual([
        `modesp/v1/${tenantA.slug}/${d.mqtt_device_id}/cmd/+`,
        `modesp/v1/pending/${d.mqtt_device_id}/cmd/+`,
      ].sort());
    });

    it('subscribe ($2 = 4) maps onto the read rows, matching read exactly', async () => {
      // ($2 = 4 AND acl.rw = 1) is what makes SUBSCRIBE reuse the READ suffixes.
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      expect(await acl(d.mqtt_username, SUBSCRIBE)).toEqual(await acl(d.mqtt_username, READ));
    });

    it('an unknown access level grants nothing', async () => {
      const d = await mkDevice({
        tenantId: tenantA.id, status: 'active', assignedAt: new Date(), lastSeen: null,
      });

      expect(await acl(d.mqtt_username, 8)).toEqual([]);
    });
  });
});
