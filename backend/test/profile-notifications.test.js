'use strict';

// globals: true in vitest.config.js
//
// The notifications page shows each channel of the signed-in person as
// «not connected / connected / last delivery» and lets them send a test through
// the same path an alarm takes (product audit item 4). A ticked checkbox used
// to be all it showed, and it looked like a working channel.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const pushSvc = require('../src/services/push');

const app = createTestApp();
const test = (hdr, channel) => request(app).post('/api/profile/notifications/test').set(hdr).send({ channel });
const state = async (hdr) => (await request(app).get('/api/profile/notifications').set(hdr)).body.data.channels;

describe('Profile — notification channels', () => {
  let tenant, user, hdr;
  const sent = [];

  beforeAll(async () => {
    await cleanDatabase();
    pushSvc.__test.reset();
    pushSvc.__test.setLogger(require('pino')({ level: 'silent' }));
    tenant = await createTenant({ slug: 'chan-test' });
    user   = await createUser(tenant.id, { role: 'technician', email: 'tech@chan.test' });
    hdr    = authHeader(user, tenant.id);
  });

  afterAll(async () => {
    pushSvc.__test.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  it('with no channel on the platform every card says so, and a test is refused with the reason', async () => {
    const res = await request(app).get('/api/profile/notifications').set(hdr);
    expect(res.status).toBe(200);
    expect(res.body.data.channels).toEqual({
      telegram: { available: false, bot_username: null, linked: false, last: null },
      webpush:  { available: false, devices: 0, last: null },
      email:    { available: false, address: 'tech@chan.test', last: null },
    });
    const t = await test(hdr, 'telegram');
    expect(t.status).toBe(409);
    expect(t.body).toMatchObject({ error: 'channel_not_ready', reason: 'channel_unavailable' });
    expect((await test(hdr, 'sms')).status).toBe(400);
    expect((await request(app).post('/api/profile/notifications/test').set(hdr).send({})).status).toBe(400);
  });

  it('Telegram: «linked» follows users.telegram_id; the test goes to that chat and is logged for the person', async () => {
    pushSvc.registerChannel('telegram', { send: async (to, payload) => { sent.push({ channel: 'telegram', to, payload }); } });
    expect(await state(hdr)).toMatchObject({ telegram: { available: true, linked: false, last: null } });

    // not linked yet: nothing is sent, the page is told what is missing
    let t = await test(hdr, 'telegram');
    expect(t.status).toBe(409);
    expect(t.body.reason).toBe('not_linked');
    expect(sent).toHaveLength(0);

    await db.query('UPDATE users SET telegram_id = 4242 WHERE id = $1', [user.id]);
    t = await test(hdr, 'telegram');
    expect(t.status).toBe(200);
    expect(t.body.data).toEqual({ status: 'sent' });
    expect(sent.at(-1)).toMatchObject({ channel: 'telegram', to: '4242', payload: { isTest: true, alarmCode: 'test_notification', lang: expect.any(String) } });

    const s = await state(hdr);
    expect(s.telegram).toMatchObject({ available: true, linked: true, last: { status: 'sent', error: null } });
    expect(new Date(s.telegram.last.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const { rows } = await db.query(
      'SELECT user_id, subscriber_id, channel, alarm_code, device_id, status FROM notification_log WHERE user_id = $1', [user.id]);
    expect(rows).toEqual([{ user_id: user.id, subscriber_id: null, channel: 'telegram', alarm_code: 'test_notification', device_id: 'TEST', status: 'sent' }]);
  });

  it('a failed test is reported as such and remembered as the last delivery', async () => {
    pushSvc.registerChannel('email', { send: async () => { throw new Error('mailbox full'); } });
    const t = await test(hdr, 'email');
    expect(t.status).toBe(200);
    expect(t.body.data).toEqual({ status: 'failed', error: 'mailbox full' });
    expect((await state(hdr)).email).toMatchObject({ available: true, address: 'tech@chan.test', last: { status: 'failed', error: 'mailbox full' } });
  });

  it('Web Push: no subscription → «no devices»; with two, both get the test', async () => {
    pushSvc.registerChannel('webpush', { send: async (sub, payload) => { sent.push({ channel: 'webpush', to: sub.endpoint, payload }); } });
    let t = await test(hdr, 'webpush');
    expect(t.status).toBe(409);
    expect(t.body.reason).toBe('no_devices');

    for (const endpoint of ['https://push.example/a', 'https://push.example/b']) {
      await request(app).post('/api/profile/push-subscription').set(hdr).send({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
    }
    t = await test(hdr, 'webpush');
    expect(t.status).toBe(200);
    expect(t.body.data).toEqual({ status: 'sent', devices: 2, sent: 2 });
    expect(sent.filter(s => s.channel === 'webpush').map(s => s.to).sort()).toEqual(['https://push.example/a', 'https://push.example/b']);
    expect((await state(hdr)).webpush).toMatchObject({ available: true, devices: 2, last: { status: 'sent' } });
  });

  it('the states are the caller’s own: another person in the organisation sees nothing linked', async () => {
    const other = await createUser(tenant.id, { role: 'viewer', email: 'viewer@chan.test' });
    const s = await state(authHeader(other, tenant.id));
    expect(s.telegram).toMatchObject({ available: true, linked: false, last: null });
    expect(s.webpush).toMatchObject({ devices: 0, last: null });
    expect(s.email).toMatchObject({ address: 'viewer@chan.test', last: null });
  });
});
