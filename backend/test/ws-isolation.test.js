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

function fakeSocket(user) {
  return { readyState: 1, bufferedAmount: 0, _user: user, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
}

describe('WebSocket global broadcast — tenant isolation', () => {
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';
  let adminA, techB, superadmin;

  beforeAll(() => setLogger(pino({ level: 'silent' })));

  beforeEach(() => {
    globalListeners.clear();
    adminA     = fakeSocket({ id: 'a', email: 'admin@a', role: 'admin', tenantId: TENANT_A });
    techB      = fakeSocket({ id: 'b', email: 'tech@b', role: 'technician', tenantId: TENANT_B });
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
