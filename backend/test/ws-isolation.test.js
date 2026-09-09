'use strict';

// globals: true in vitest.config.js
//
// broadcastGlobal() fans tenant-wide events (alarms, pending devices) out to
// every socket that subscribed globally. Before plan epic 1.7 only
// pending_device was filtered, so an admin of organisation A received the
// alarms of organisation B. Driven here with fake sockets — no server needed.

// ws.js reads AUTH_ENABLED at require time; without it every socket is trusted.
process.env.AUTH_ENABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-must-be-at-least-32-characters-long';

const pino = require('pino');
const wsSvc = require('../src/services/ws');

const { broadcastGlobal, globalListeners, setLogger } = wsSvc.__test;

// scope: the mqtt ids a grant-limited client holds. A fresh _deviceScopeAt keeps
// the background refresh (which would hit the database) out of these tests.
function fakeSocket(user, scope) {
  const ws = { readyState: 1, bufferedAmount: 0, _user: user, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
  if (scope) { ws._deviceScope = new Set(scope); ws._deviceScopeAt = Date.now(); }
  return ws;
}

describe('WebSocket global broadcast — tenant isolation', () => {
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';
  let adminA, techB, superadmin;

  beforeAll(() => setLogger(pino({ level: 'silent' })));

  beforeEach(() => {
    globalListeners.clear();
    adminA     = fakeSocket({ id: 'a', email: 'admin@a', role: 'admin', tenantId: TENANT_A });
    techB      = fakeSocket({ id: 'b', email: 'tech@b', role: 'technician', tenantId: TENANT_B }, ['D2']);
    superadmin = fakeSocket({ id: 's', email: 'super', role: 'superadmin', tenantId: TENANT_A });
    for (const ws of [adminA, techB, superadmin]) globalListeners.add(ws);
  });

  afterAll(() => globalListeners.clear());

  it('an alarm reaches only the sockets of its own tenant, plus the superadmin', () => {
    broadcastGlobal({ type: 'alarm', device_id: 'D1', alarm_code: 'door_alarm', active: true, tenant_slug: 'a', tenant_id: TENANT_A });
    expect(adminA.sent).toHaveLength(1);
    expect(techB.sent).toHaveLength(0);
    expect(superadmin.sent).toHaveLength(1);

    broadcastGlobal({ type: 'alarm', device_id: 'D2', alarm_code: 'door_alarm', active: false, tenant_slug: 'b', tenant_id: TENANT_B });
    expect(adminA.sent).toHaveLength(1);
    expect(techB.sent).toHaveLength(1);
    expect(superadmin.sent).toHaveLength(2);
  });

  it('pending_device and any event without tenant context stay with the superadmin', () => {
    broadcastGlobal({ type: 'pending_device', device_id: 'P1', action: 'added' });
    broadcastGlobal({ type: 'something_new', device_id: 'X' });
    expect(adminA.sent).toHaveLength(0);
    expect(techB.sent).toHaveLength(0);
    expect(superadmin.sent).toHaveLength(2);
  });

  it('skips sockets that are closed or back-pressured', () => {
    adminA.readyState = 3;
    superadmin.bufferedAmount = 1 << 20;
    broadcastGlobal({ type: 'alarm', device_id: 'D1', tenant_id: TENANT_A });
    expect(adminA.sent).toHaveLength(0);
    expect(superadmin.sent).toHaveLength(0);
  });
});

// Tenant isolation was only half the boundary. Every signed-in user subscribes to
// the global channel, and it carries every alarm, hint and work order of the
// organisation — so a viewer holding no grant at all was fed the device id, alarm
// code and severity of every cabinet in the company, while GET /alarms, filtered
// by the same grants, showed them nothing. The feed now answers the same question.
describe('WebSocket global broadcast — per-device grants', () => {
  const TENANT = '33333333-3333-3333-3333-333333333333';
  let admin, tech, viewer, stranger;

  beforeAll(() => setLogger(pino({ level: 'silent' })));

  beforeEach(() => {
    globalListeners.clear();
    admin    = fakeSocket({ id: 'ad', email: 'admin@t',  role: 'admin',      tenantId: TENANT });
    tech     = fakeSocket({ id: 'te', email: 'tech@t',   role: 'technician', tenantId: TENANT }, ['MINE1', 'MINE2']);
    viewer   = fakeSocket({ id: 'vi', email: 'viewer@t', role: 'viewer',     tenantId: TENANT }, []);
    // Subscribed before its grant set finished loading, or the load failed.
    stranger = fakeSocket({ id: 'st', email: 'nobody@t', role: 'viewer',     tenantId: TENANT });
    for (const ws of [admin, tech, viewer, stranger]) globalListeners.add(ws);
  });

  afterAll(() => globalListeners.clear());

  it('an alarm reaches the admin and only the holders of that device', () => {
    broadcastGlobal({ type: 'alarm', device_id: 'MINE1', alarm_code: 'high_temp_alarm', active: true, tenant_id: TENANT });
    expect(admin.sent).toHaveLength(1);
    expect(tech.sent).toHaveLength(1);
    expect(viewer.sent).toHaveLength(0);

    broadcastGlobal({ type: 'alarm', device_id: 'OTHER', alarm_code: 'high_temp_alarm', active: true, tenant_id: TENANT });
    expect(admin.sent).toHaveLength(2);
    expect(tech.sent).toHaveLength(1);      // not theirs — the id never reaches them
    expect(viewer.sent).toHaveLength(0);
  });

  it('hints and work orders are filtered the same way', () => {
    broadcastGlobal({ type: 'hint', device_id: 'MINE2', rule_key: 'short_cycle', active: true, tenant_id: TENANT });
    broadcastGlobal({ type: 'work_order', device_id: 'OTHER', status: 'open', action: 'created', tenant_id: TENANT });
    expect(tech.sent.map(m => m.type)).toEqual(['hint']);
    expect(admin.sent).toHaveLength(2);
  });

  it('a work order with no device still reaches the person it is assigned to', () => {
    broadcastGlobal({ type: 'work_order', order_id: 'o1', device_id: null, status: 'open', action: 'assigned', assigned_to: 'te', tenant_id: TENANT });
    expect(tech.sent).toHaveLength(1);
    expect(viewer.sent).toHaveLength(0);

    broadcastGlobal({ type: 'work_order', order_id: 'o2', device_id: null, status: 'open', action: 'assigned', assigned_to: 'someone-else', tenant_id: TENANT });
    expect(tech.sent).toHaveLength(1);
  });

  it('a socket whose grant set never loaded receives nothing at all', () => {
    broadcastGlobal({ type: 'alarm', device_id: 'MINE1', alarm_code: 'door_alarm', active: true, tenant_id: TENANT });
    broadcastGlobal({ type: 'work_order', order_id: 'o3', device_id: null, status: 'open', action: 'created', assigned_to: 'st', tenant_id: TENANT });
    expect(stranger.sent).toHaveLength(0);
  });
});
