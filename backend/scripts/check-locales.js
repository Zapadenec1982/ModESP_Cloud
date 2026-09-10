#!/usr/bin/env node
'use strict';

/**
 * Locale parity of the notification templates — `node scripts/check-locales.js`
 *
 * Telegram, e-mail and web push each keep a dictionary per language
 * (uk / en / pl / de). A key missing in one language would render as the
 * Ukrainian fallback or as the raw key, so this diffs the key sets and exits
 * 1 on any gap. Wired into CI next to the WebUI check
 * (webui/scripts/check-i18n-parity.mjs).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { SUPPORTED_LOCALES } = require('../src/lib/locale');
const telegram = require('../src/services/telegram');
const email    = require('../src/services/email');
const pushStrings = require('../src/lib/push-strings');
const invoicePdf = require('../src/services/invoice-pdf');
const periodReports = require('../src/services/period-reports');
const haccpReport = require('../src/services/haccp-report');
const serviceReport = require('../src/services/service-report');

const flatten = (obj, prefix = '', out = new Set()) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.add(key);
  }
  return out;
};

let failed = false;
function check(name, dict) {
  const langs = Object.keys(dict);
  const missingLangs = SUPPORTED_LOCALES.filter(l => !langs.includes(l));
  if (missingLangs.length) { failed = true; console.log(`${name}: no dictionary for ${missingLangs.join(', ')}`); }
  const keys = Object.fromEntries(langs.map(l => [l, flatten(dict[l])]));
  const all = new Set(langs.flatMap(l => [...keys[l]]));
  for (const l of langs) {
    const missing = [...all].filter(k => !keys[l].has(k)).sort();
    console.log(`${name} ${l}: ${keys[l].size} keys, ${missing.length} missing`);
    if (missing.length) { failed = true; console.log('  ' + missing.join('\n  ')); }
  }
}

check('telegram.STRINGS', telegram.__strings.STRINGS);
for (const [name, dict] of Object.entries(email.__strings)) check(`email.${name}`, dict);
// Shared by browser push and FCM (lib/push-strings.js) — one dictionary, two channels.
check('push.ALARM_NAMES', pushStrings.ALARM_NAMES);
check('push.W', pushStrings.W);
check('invoice-pdf.STRINGS', invoicePdf.STRINGS);
check('period-reports.STRINGS', periodReports.STRINGS);
check('haccp-report.STRINGS', haccpReport.STRINGS);
check('service-report.STRINGS', serviceReport.STRINGS);

process.exit(failed ? 1 : 0);
