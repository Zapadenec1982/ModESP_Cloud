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
