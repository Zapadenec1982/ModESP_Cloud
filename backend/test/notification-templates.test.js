'use strict';

// globals: true in vitest.config.js
//
// Notification templates in four languages (plan epic 2.11): Telegram, e-mail
// and web push render whatever payload.lang / payload.timezone say —
// push.withUserLocale() resolves those per recipient (user, then organisation,
// then the platform default). No channel is initialised here; the builders
// are pure.

const email    = require('../src/services/email');
const webpush  = require('../src/services/webpush');
const telegram = require('../src/services/telegram');
const locale   = require('../src/lib/locale');

const AT = '2026-09-05T12:00:00Z';
const raised  = (lang, timezone) => ({ alarmCode: 'high_temp_alarm', severity: 'critical', active: true, deviceId: 'TPL001', deviceName: 'Камера 1', location: 'Склад', airTemp: -12.3, timestamp: AT, lang, timezone });
const cleared = (lang) => ({ alarmCode: 'door_alarm', active: false, deviceId: 'TPL001', deviceName: 'Камера 1', duration: 135 * 60000, timestamp: AT, lang });
const hint    = (lang) => ({ type: 'hint', ruleKey: 'alarm_repeat', sourceAlarmCode: 'rapid_cycle_alarm', value: 4, threshold: 3, windowHours: 168, deviceId: 'TPL001', deviceName: 'Камера 1', timestamp: AT, lang });
const order   = (lang) => ({ type: 'work_order', orderId: 7, title: 'Замінити реле', priority: 'urgent', siteName: 'Магазин', siteAddress: 'вул. Головна 1', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=50.45,30.52', scheduledAt: AT, timestamp: AT, lang, timezone: 'Europe/Warsaw' });

describe('notification templates in uk / en / pl / de', () => {
  it('lib/locale resolves user → organisation → platform and formats in the zone', () => {
    expect(locale.pickLocale(undefined, null, 'pl')).toBe('pl');
    expect(locale.pickLocale('fr', 'xx')).toBe('uk');
    expect(locale.pickTimezone('Mars/Olympus', 'Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(locale.pickTimezone()).toBe('Europe/Kyiv');
    expect(locale.formatDateTime(AT, { locale: 'en', timezone: 'Europe/London' })).toBe('05/09/2026, 13:00');
    expect(locale.formatDateTime(AT, { locale: 'de', timezone: 'Europe/Berlin' })).toBe('05.09.2026, 14:00');
    expect(locale.formatDuration(135 * 60000, 'pl')).toBe('2 godz. 15 min');
    expect(locale.formatDuration(20000, 'de')).toBe('<1 Min.');
  });

  it('e-mail: subject and labels follow the language, the time follows the zone, html lang is set', () => {
    const subjects = {};
    for (const lang of ['uk', 'en', 'pl', 'de']) {
      const { subject, html } = email.__test.buildEmail(raised(lang, 'Europe/Warsaw'));
      subjects[lang] = subject;
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain('14:00');          // 12:00Z in Warsaw
    }
    expect(subjects.uk).toContain('Висока температура');
    expect(subjects.en).toContain('High Temperature');
    expect(subjects.pl).toContain('Wysoka temperatura');
    expect(subjects.de).toContain('Hohe Temperatur');

    expect(email.__test.buildEmail(cleared('pl')).subject).toBe('✅ Drzwi otwarte — ustąpił — Камера 1');
    expect(email.__test.buildEmail(cleared('pl')).html).toContain('2 godz. 15 min');
    expect(email.__test.buildEmail(hint('de')).subject).toBe('🔧 Alarm wiederholt sich: Häufige Zyklen — Камера 1');
    expect(email.__test.buildEmail(hint('de')).html).toContain('4-mal in 7 Tagen (Grenze 3)');
    expect(email.__test.buildEmail(order('en')).subject).toBe('📋 Work order #7: Замінити реле — Магазин');
    expect(email.__test.buildEmail(order('en')).html).toContain('Route to the site');
    expect(email.__test.buildEmail({ isTest: true, lang: 'pl' }).subject).toBe('ModESP Cloud — Powiadomienie testowe');
    // an unknown language falls back to Ukrainian, never to a raw key
    expect(email.__test.buildEmail(raised('xx')).subject).toContain('Висока температура');
  });

  it('web push: title and body per language', () => {
    expect(webpush.__test.buildNotification(raised('de'))).toMatchObject({ title: '🚨 Hohe Temperatur', body: 'Камера 1 (Склад) | -12.3°C' });
    expect(webpush.__test.buildNotification({ ...raised('en'), escalation: { minutes: 15 } }).title).toBe('⏫ 15 min unacknowledged: High temperature');
    expect(webpush.__test.buildNotification(cleared('pl'))).toMatchObject({ title: '✅ Drzwi otwarte — ustąpił', body: 'Камера 1 | 2 godz. 15 min' });
    expect(webpush.__test.buildNotification(hint('en'))).toMatchObject({ title: '🔧 Recurring alarm: Rapid cycling', body: 'Камера 1 · 4× in 7 days', tag: 'hint-TPL001-rapid_cycle_alarm' });
    expect(webpush.__test.buildNotification({ type: 'device_offline', deviceName: 'Камера 1', lang: 'uk' })).toMatchObject({ title: '⚠️ Камера 1 — офлайн', body: 'Пристрій не відповідає' });
    expect(webpush.__test.buildNotification(order('pl')).title).toBe('📋 Zlecenie #7: Замінити реле');
  });

  it('telegram: payload.lang wins over the chat language and the time zone is the recipient\'s', () => {
    telegram.__test.setLang('42', 'uk');
    const pl = telegram.__test.renderNotification('42', raised('pl', 'Europe/Warsaw'));
    expect(pl).toContain('ALARM: Wysoka temperatura');
    expect(pl).toContain('Urządzenie: Камера 1 (TPL001)');
    expect(pl).toContain('05.09.2026, 14:00');
    expect(pl).toContain('Alarm krytyczny');

    const de = telegram.__test.renderNotification('42', hint('de'));
    expect(de).toContain('Wartungsempfehlung: Alarm wiederholt sich');
    expect(de).toContain('Häufige Verdichterzyklen — 4 mal in 7 Tagen (Grenze 3)');

    const en = telegram.__test.renderNotification('42', cleared('en'));
    expect(en).toContain('Alarm cleared: Door open');
    expect(en).toContain('Duration: 2 h 15 min');

    // without payload.lang the chat's language stands
    telegram.__test.setLang('43', 'de');
    expect(telegram.__test.renderNotification('43', { ...raised(undefined, undefined), lang: undefined })).toContain('ALARM: Hohe Temperatur');
    // every language has every key — the CI parity script checks the same thing
    const keys = Object.keys(telegram.__strings.STRINGS.uk);
    for (const l of ['en', 'pl', 'de']) expect(Object.keys(telegram.__strings.STRINGS[l]).sort()).toEqual([...keys].sort());
  });
});
