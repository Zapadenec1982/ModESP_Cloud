'use strict';

// globals: true in vitest.config.js
//
// Every notification is supposed to reach its recipient in their own language —
// push.js resolves it per person (user → organisation → uk) and puts it in
// payload.lang, and FEATURES_UA.md says so plainly.
//
// FCM was the one channel of eight that never read it. It carried its own eleven
// alarm names, in English, and nothing else: a Ukrainian user got «High Temperature»
// on the phone while the same alarm reached them as «Висока температура» by e-mail,
// Telegram and browser push. Both channels now build their text from
// lib/push-strings.js, so they cannot drift again.

const fcm = require('../src/services/fcm');
const webpush = require('../src/services/webpush');
const { buildNotification } = require('../src/lib/push-strings');

const LANGS = ['uk', 'en', 'pl', 'de'];
const alarm = (lang, over = {}) => ({
  lang, deviceId: 'FCM001', deviceName: 'Вітрина 1', location: 'Зал',
  alarmCode: 'protection.high_temp_alarm', severity: 'critical', airTemp: -2.5,
  timestamp: '2026-09-10T00:00:00Z', active: true, ...over,
});

describe('The mobile push speaks the recipient’s language (H13)', () => {
  it('titles the same alarm differently in each of the four languages', () => {
    const titles = LANGS.map(l => fcm.__test.buildMessage('tok', alarm(l)).notification.title);
    expect(titles).toEqual([
      '🚨 Висока температура',
      '🚨 High temperature',
      '🚨 Wysoka temperatura',
      '🚨 Hohe Temperatur',
    ]);
    // Four distinct strings — the defect was one English string for all four.
    expect(new Set(titles).size).toBe(4);
  });

  it('says the same thing as the browser push, word for word', () => {
    for (const lang of LANGS) {
      const payload = alarm(lang);
      const web = buildNotification(payload);
      const msg = fcm.__test.buildMessage('tok', payload);
      expect(msg.notification.title).toBe(web.title);
      expect(msg.notification.body).toBe(web.body);
    }
    // …and the browser channel really is reading the same module.
    expect(webpush.__test.buildNotification(alarm('uk')).title).toBe('🚨 Висока температура');
  });

  it('localises the test notification and a cleared alarm too', () => {
    const test = (lang) => fcm.__test.buildMessage('tok', alarm(lang, { isTest: true, alarmCode: 'test_notification' }));
    expect(test('uk').notification.body).toBe('Тестове сповіщення надіслано успішно.');
    expect(test('de').notification.body).toBe('Testbenachrichtigung erfolgreich gesendet.');

    const cleared = (lang) => fcm.__test.buildMessage('tok', alarm(lang, { active: false, duration: 3600 }));
    expect(cleared('uk').notification.title).toBe('✅ Висока температура — знято');
    expect(cleared('pl').notification.title).toBe('✅ Wysoka temperatura — ustąpił');
  });

  it('falls back to Ukrainian when the payload carries no language', () => {
    const msg = fcm.__test.buildMessage('tok', alarm(undefined));
    expect(msg.notification.title).toBe('🚨 Висока температура');
  });

  it('keeps what belongs to the phone: priority, channel, data', () => {
    const msg = fcm.__test.buildMessage('the-token', alarm('uk'));
    expect(msg.token).toBe('the-token');
    expect(msg.android.priority).toBe('high');              // critical
    expect(msg.android.notification.channelId).toBe('modesp_alarms');
    expect(msg.apns.payload.aps.category).toBe('ALARM');
    expect(msg.data).toEqual({
      deviceId: 'FCM001', alarmCode: 'protection.high_temp_alarm',
      severity: 'critical', timestamp: '2026-09-10T00:00:00Z',
    });

    const warn = fcm.__test.buildMessage('t', alarm('uk', { severity: 'warning' }));
    expect(warn.android.priority).toBe('normal');
    expect(warn.android.notification.priority).toBe('high');
  });

  it('renders an unknown alarm code as itself rather than blank', () => {
    const msg = fcm.__test.buildMessage('t', alarm('uk', { alarmCode: 'protection.brand_new_alarm' }));
    expect(msg.notification.title).toBe('🚨 protection.brand_new_alarm');
  });
});
