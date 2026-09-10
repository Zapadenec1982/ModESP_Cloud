'use strict';

// globals: true in vitest.config.js
//
// EMAIL_REPLY_TO: every platform e-mail carries the configured Reply-To, a
// message that sets its own keeps it, and nothing is added when unset.

const emailSvc = require('../src/services/email');

function fakeClient() {
  const sent = [];
  return { sent, client: { emails: { send: async (msg) => { sent.push(msg); return { data: { id: 'x' } }; } } } };
}

describe('EMAIL_REPLY_TO', () => {
  it('is added to every message when configured', async () => {
    const { sent, client } = fakeClient();
    emailSvc.__test.setClient(client, { from: 'ModESP Cloud <alerts@mail.test.local>', replyTo: 'support@test.local' });
    await emailSvc.sendPasswordReset({ to: 'user@example.com', link: 'https://x/#/reset', code: 'ABCDEFGH12345678', lang: 'uk' });
    await emailSvc.sendInvitation({ to: 'new@example.com', link: 'https://x/#/invite/t', tenantName: 'Морозко', role: 'technician', invitedBy: 'admin@example.com', lang: 'en' });
    await emailSvc.sendScheduledReport({
      to: ['haccp@example.com'], lang: 'uk', tenantName: 'Морозко', type: 'haccp', cadence: 'monthly',
      periodFrom: '2026-08-01T00:00:00Z', periodTo: '2026-09-01T00:00:00Z', tz: 'Europe/Kyiv',
      sites: [{ name: 'Магазин', code: 'AAAA-BBBB-CCCC', empty: false, error: false }], attachments: [], link: 'https://x/#/reports',
    });
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      expect(m.replyTo).toBe('support@test.local');
      expect(m.from).toBe('ModESP Cloud <alerts@mail.test.local>');
    }
  });

  it('a message with its own Reply-To keeps it', async () => {
    const { sent, client } = fakeClient();
    emailSvc.__test.setClient(client, { replyTo: 'support@test.local' });
    await emailSvc.sendPilotRequest({ to: 'founder@test.local', request: { email: 'asker@example.com', name: 'Іван', company: 'Кафе', phone: '', sites: 2, devices: 5, message: 'hi', locale: 'uk' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toBe('asker@example.com');
  });

  it('adds nothing when unset', async () => {
    const { sent, client } = fakeClient();
    emailSvc.__test.setClient(client, { replyTo: null });
    await emailSvc.sendTrialEnded({ to: 'admin@example.com', link: 'https://x/#/billing', tenantName: 'Морозко', lang: 'pl' });
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toBeUndefined();
    emailSvc.__test.setClient(null);
  });
});

// ── where the links in an e-mail point ─────────────────────
//
// EMAIL_APP_URL already names the WebUI (…/cloud, since the landing page took
// "/"). Two builders still appended the pre-move `/app/#/…`, producing
// …/cloud/app/#/device/X — /app is the separate mobile PWA, a sibling of /cloud
// and never a child of it. So the button in every alarm e-mail, and the one in
// the rollout e-mail, led nowhere. The rest of the file had already moved to the
// spaLink() helper; these two had not.
describe('e-mail links point at the WebUI, not at the old /app path', () => {
  const APP = 'https://modesp.example/cloud';

  beforeAll(() => { emailSvc.__test.setClient(null, { app: APP }); });

  it('the alarm e-mail opens the device page', () => {
    const { html } = emailSvc.__test.buildEmail({
      lang: 'uk', severity: 'critical', alarmCode: 'high_temp_alarm',
      deviceId: 'A4CF12', deviceName: 'Камера', deviceUuid: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-09-09T10:00:00Z',
    });
    expect(html).toContain(`${APP}/#/device/11111111-1111-1111-1111-111111111111`);
    expect(html).not.toContain('/app/#/');
  });

  it('the rollout e-mail opens the firmware page', () => {
    const { html } = emailSvc.__test.buildEmail({
      lang: 'uk', type: 'rollout', firmwareVersion: '1.2.3', total: 10, succeeded: 9, failed: 1,
      timestamp: '2026-09-09T10:00:00Z',
    });
    expect(html).toContain(`${APP}/#/firmware`);
    expect(html).not.toContain('/app/#/');
  });
});
