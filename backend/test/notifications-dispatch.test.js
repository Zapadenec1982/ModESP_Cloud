'use strict';

// globals: true in vitest.config.js
//
// Who gets notified (plan epic 1.6): admins of the organisation, technicians
// and viewers through user_devices ∪ user_sites, superadmins only when they
// opted in; every user's preferences (enabled, minimum severity, channels,
// quiet hours) are honoured; unacknowledged critical alarms escalate once.
// A fake Telegram channel records what would have been sent.

const pino = require('pino');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess } = require('./helpers/factories');
const push = require('../src/services/push');

const T = push.__test;
let sent = [];
const fakeTelegram = { send: async (address, payload) => { sent.push({ address, payload }); } };

function armChannel() {
  T.reset();
  sent = [];
  push.registerChannel('telegram', fakeTelegram);
}

const recipients = () => sent.map(s => s.address).sort();

describe('notification dispatch', () => {
  let tenant, site, device, admin, techSite, techNone, viewerDev, superOff, superOn;
  const evtBase = { tenantSlug: 'dispatch-test', deviceId: 'DSP001', alarmCode: 'door_alarm', active: true, severity: 'warning' };

  beforeAll(async () => {
    await cleanDatabase();
    T.setLogger(pino({ level: 'silent' }));
    tenant = await createTenant({ slug: 'dispatch-test' });
    const { rows } = await db.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Store 1') RETURNING id`, [tenant.id]);
    site = rows[0];
    device = await createDevice(tenant.id, { mqttId: 'DSP001' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, device.id]);

    admin     = await createUser(tenant.id, { role: 'admin',      email: 'admin@dsp.test' });
    techSite  = await createUser(tenant.id, { role: 'technician', email: 'site@dsp.test' });
    techNone  = await createUser(tenant.id, { role: 'technician', email: 'none@dsp.test' });
    viewerDev = await createUser(tenant.id, { role: 'viewer',     email: 'viewer@dsp.test' });
    superOff  = await createUser(tenant.id, { role: 'superadmin', email: 'super-off@dsp.test' });
    superOn   = await createUser(tenant.id, { role: 'superadmin', email: 'super-on@dsp.test' });

    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)', [techSite.id, site.id, tenant.id, admin.id]);
    await grantDeviceAccess(viewerDev.id, device.id, admin.id);
    await db.query('UPDATE users SET receive_all_tenant_alerts = true WHERE id = $1', [superOn.id]);

    // Telegram ids are the addresses the fake channel records
    const ids = { [admin.id]: 1001, [techSite.id]: 1002, [techNone.id]: 1003, [viewerDev.id]: 1004, [superOff.id]: 1005, [superOn.id]: 1006 };
    for (const [id, tg] of Object.entries(ids)) await db.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [tg, id]);
  });

  afterAll(async () => {
    T.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  beforeEach(async () => {
    armChannel();
    await db.query('DELETE FROM user_notification_prefs');
    await db.query('DELETE FROM notification_log');
  });

  it('each recipient gets the message in their own language and time zone, else the organisation\'s (plan epic 2.11)', async () => {
    await db.query(`INSERT INTO tenant_settings (tenant_id, locale, timezone) VALUES ($1, 'pl', 'Europe/Warsaw')
                    ON CONFLICT (tenant_id) DO UPDATE SET locale = 'pl', timezone = 'Europe/Warsaw'`, [tenant.id]);
    await db.query(`UPDATE users SET locale = 'de', timezone = 'Europe/Berlin' WHERE id = $1`, [admin.id]);
    await db.query(`UPDATE users SET locale = NULL, timezone = NULL WHERE id = $1`, [techSite.id]);
    try {
      await T.handleAlarm({ ...evtBase, alarmCode: 'high_temp_alarm', severity: 'critical' });
      const byAddr = Object.fromEntries(sent.map(s => [s.address, s.payload]));
      expect(byAddr['1001']).toMatchObject({ lang: 'de', timezone: 'Europe/Berlin' });   // the admin's own choice
      expect(byAddr['1002']).toMatchObject({ lang: 'pl', timezone: 'Europe/Warsaw' });   // the organisation's
      expect(T.withUserLocale({ x: 1 }, { user_locale: 'xx', user_timezone: 'Nowhere/City' }, { locale: 'en', timezone: 'Europe/London' }))
        .toEqual({ x: 1, lang: 'en', timezone: 'Europe/London' });
      expect(T.withUserLocale({}, null, null)).toEqual({ lang: 'uk', timezone: 'Europe/Kyiv' });
    } finally {
      await db.query(`UPDATE users SET locale = NULL, timezone = NULL WHERE id = $1`, [admin.id]);
      await db.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenant.id]);
    }
  });

  it('reaches admins, site-granted and device-granted users; not the ungranted technician or an opted-out superadmin', async () => {
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'DSP001', 'door_alarm', 'warning', true) RETURNING id`, [tenant.id]);
    await T.handleAlarm({ ...evtBase, alarmId: rows[0].id });

    expect(recipients()).toEqual(['1001', '1002', '1004', '1006']);
    expect(sent[0].payload).toMatchObject({ alarmCode: 'door_alarm', severity: 'warning', active: true, alarmId: rows[0].id });

    const { rows: log } = await db.query(
      'SELECT user_id, channel, status, alarm_id FROM notification_log WHERE alarm_id = $1 ORDER BY user_id', [rows[0].id]);
    expect(log).toHaveLength(4);
    expect(log.every(l => l.channel === 'telegram' && l.status === 'sent' && l.user_id)).toBe(true);
  });

  it('honours minimum severity, disabled preferences and quiet hours (critical bypasses quiet hours)', async () => {
    await db.query(`INSERT INTO user_notification_prefs (user_id, min_severity) VALUES ($1, 'critical')`, [techSite.id]);
    await db.query(`INSERT INTO user_notification_prefs (user_id, enabled) VALUES ($1, false)`, [viewerDev.id]);
    // Admin: quiet hours that cover "now" in UTC
    const now = new Date();
    const hh = (h) => String(((h % 24) + 24) % 24).padStart(2, '0') + ':00';
    await db.query(`INSERT INTO user_notification_prefs (user_id, quiet_from, quiet_to, quiet_tz) VALUES ($1, $2, $3, 'UTC')`,
      [admin.id, hh(now.getUTCHours() - 1), hh(now.getUTCHours() + 2)]);

    await T.handleAlarm({ ...evtBase, alarmCode: 'pulldown_alarm' });
    expect(recipients()).toEqual(['1006']);                       // only the opted-in superadmin

    armChannel();
    await T.handleAlarm({ ...evtBase, alarmCode: 'high_temp_alarm', severity: 'critical' });
    expect(recipients()).toEqual(['1001', '1002', '1006']);       // quiet hours and min severity yield to critical
  });

  it('turns a channel off per user', async () => {
    await db.query(`INSERT INTO user_notification_prefs (user_id, telegram) VALUES ($1, false)`, [admin.id]);
    await T.handleAlarm({ ...evtBase, alarmCode: 'sensor1_alarm' });
    expect(recipients()).toEqual(['1002', '1004', '1006']);
  });

  it('renders offline alarms with the offline template type and their clear as a plain clear', async () => {
    await T.handleAlarm({ ...evtBase, alarmCode: 'device_offline', severity: 'warning', active: true, lastSeen: '2026-09-02T09:00:00.000Z' });
    expect(sent[0].payload.type).toBe('device_offline');
    expect(sent[0].payload.lastSeen).toBe('2026-09-02T09:00:00.000Z');
    armChannel();
    await T.handleAlarm({ ...evtBase, alarmCode: 'device_offline', severity: 'warning', active: false });
    expect(sent[0].payload.type).toBeUndefined();
    expect(sent[0].payload.active).toBe(false);
  });

  it('escalates an unacknowledged critical alarm once, to admins only', async () => {
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'DSP001', 'high_temp_alarm', 'critical', true, now() - interval '20 minutes') RETURNING id`, [tenant.id]);
    const { rows: acked } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, acknowledged_by, acknowledged_at)
       VALUES ($1, 'DSP001', 'low_temp_alarm', 'critical', true, now() - interval '20 minutes', $2, now()) RETURNING id`, [tenant.id, techSite.id]);
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'DSP001', 'sensor2_alarm', 'critical', true, now() - interval '5 minutes')`, [tenant.id]);

    const n = await T.runEscalations();
    expect(n).toBe(1);
    expect(recipients()).toEqual(['1001', '1006']);
    expect(sent[0].payload.type).toBe('alarm_escalation');
    expect(sent[0].payload.escalation.minutes).toBe(T.ESCALATION_MIN);
    expect(sent[0].payload.alarmId).toBe(rows[0].id);

    const { rows: after } = await db.query('SELECT id, escalated_at FROM alarms WHERE id = ANY($1) ORDER BY id', [[rows[0].id, acked[0].id]]);
    expect(after[0].escalated_at).not.toBeNull();
    expect(after[1].escalated_at).toBeNull();

    armChannel();
    expect(await T.runEscalations()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('evaluatePrefs() and quiet hours', () => {
  it('handles overnight quiet ranges and the critical bypass', () => {
    const at = (h) => new Date(Date.UTC(2026, 8, 2, h, 30));
    const pref = { quiet_from: '22:00', quiet_to: '07:00', quiet_tz: 'UTC' };
    expect(T.inQuietHours(pref, at(23))).toBe(true);
    expect(T.inQuietHours(pref, at(3))).toBe(true);
    expect(T.inQuietHours(pref, at(12))).toBe(false);
    expect(T.inQuietHours({ quiet_from: null, quiet_to: null }, at(3))).toBe(false);

    const user = { ...pref, pref_enabled: true, min_severity: 'warning' };
    expect(T.evaluatePrefs(user, { severity: 'info' }).reason).toBe('below_min_severity');
    expect(T.evaluatePrefs(user, { severity: 'warning' }, { now: at(3) }).reason).toBe('quiet_hours');
    expect(T.evaluatePrefs(user, { severity: 'critical' }, { now: at(3) }).deliver).toBe(true);
    expect(T.evaluatePrefs(user, { severity: 'warning' }, { now: at(3), ignoreQuietHours: true }).deliver).toBe(true);
    expect(T.evaluatePrefs({ pref_enabled: false }, { severity: 'critical' }).reason).toBe('disabled');
    expect(T.evaluatePrefs({ pref_email: false }, { severity: 'warning' }).channels).toEqual({ telegram: true, webpush: true, email: false });
  });
});
