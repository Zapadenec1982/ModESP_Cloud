'use strict';

// globals: true in vitest.config.js
//
// One number, one place.
//
// DOOR_ALARM_DELAY_MS, HACCP_EXCURSION_MIN and HOURLY_RETENTION_DAYS each had
// their default written in several files, and only some of them read the
// environment. The HACCP report kept private copies and spelled «3 роки» into the
// sentence the inspector reads, in four languages.
//
// So an operator who set DOOR_ALARM_DELAY_MS=300000 got a platform that alarmed
// after five minutes and a certified document that still said «doors > 10 min» —
// a false statement in a compliance record, produced by the platform itself.
//
// These tests read the values through the modules that use them, so a future copy
// made somewhere else shows up here.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const defaults = require('../src/lib/platform-defaults');
const haccp = require('../src/services/haccp-report');

/** The value each module ends up with, under a given environment. */
function underEnv(env) {
  const script = `
    const d = require('${path.join(__dirname, '../src/lib/platform-defaults')}');
    const h = require('${path.join(__dirname, '../src/services/haccp-report')}');
    const c = require('${path.join(__dirname, '../scripts/cleanup-telemetry')}');
    process.stdout.write(JSON.stringify({
      door: d.DOOR_ALARM_DELAY_MS,
      excursion: d.HACCP_EXCURSION_MIN,
      hourly: d.HOURLY_RETENTION_DAYS,
      years: d.hourlyRetentionYears(),
      reportHourly: h.HOURLY_RETENTION_DAYS,
      reportDoor: h.helpers.DEFAULT_DOOR_DELAY_MS,
      reportExcursion: h.helpers.DEFAULT_EXCURSION_MIN,
      sweepHourly: c.HOURLY_RETENTION_DAYS,
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('Platform defaults come from one place (M2, M4)', () => {
  it('ships the documented values', () => {
    expect(defaults.DOOR_ALARM_DELAY_MS).toBe(600_000);   // 10 min
    expect(defaults.HACCP_EXCURSION_MIN).toBe(30);
    expect(defaults.HOURLY_RETENTION_DAYS).toBe(1095);    // three years
    expect(defaults.hourlyRetentionYears()).toBe(3);
  });

  it('the report reads the same numbers as the platform, not copies of its own', () => {
    const v = underEnv({});
    expect(v.reportDoor).toBe(v.door);
    expect(v.reportExcursion).toBe(v.excursion);
    expect(v.reportHourly).toBe(v.hourly);
    expect(v.sweepHourly).toBe(v.hourly);
  });

  it('changing the environment moves every consumer together', () => {
    const v = underEnv({
      DOOR_ALARM_DELAY_MS: '300000',      // five minutes
      HACCP_EXCURSION_MIN: '15',
      HOURLY_RETENTION_DAYS: '730',       // two years
    });
    expect(v.door).toBe(300_000);
    expect(v.reportDoor).toBe(300_000);   // the PDF says five minutes too
    expect(v.excursion).toBe(15);
    expect(v.reportExcursion).toBe(15);
    expect(v.hourly).toBe(730);
    expect(v.reportHourly).toBe(730);
    expect(v.sweepHourly).toBe(730);      // and the sweep deletes by the same
    expect(v.years).toBe(2);
  });

  it('ignores a value that is not a positive number', () => {
    for (const bad of ['', 'ten minutes', '0', '-5']) {
      expect(underEnv({ DOOR_ALARM_DELAY_MS: bad }).door).toBe(600_000);
    }
  });

  it('the retention sentence names the years the archive really keeps', () => {
    // «погодинний архів — 3 р.» was a literal in all four languages, so lowering
    // the retention left the document promising an archive that was gone.
    for (const lang of ['uk', 'en', 'pl', 'de']) {
      expect(haccp.STRINGS[lang].retention_text).toContain('{2}');
      expect(haccp.STRINGS[lang].retention_text).not.toMatch(/\b3\s*(роки|years|lata|Jahre)/);
    }
  });
});
