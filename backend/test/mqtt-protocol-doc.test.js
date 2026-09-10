'use strict';

// globals: true in vitest.config.js
//
// docs/MQTT_PROTOCOL.md says «Повний перелік subscribe keys» and then lists them
// by hand. state_meta.json is the real list — it is what the cloud validates a
// command against and what GET /api/meta serves to the WebUI. The two drifted by
// one: `defrost.manual_stop` existed in the code, was marked dangerous (so the
// interface asks before sending it), and appeared nowhere in the protocol
// document. Firmware authors and integrators read that document; a command
// missing from it is a command nobody implements.
//
// The count in the heading is part of the claim, so it is checked too.

const fs   = require('fs');
const path = require('path');

const DOC  = path.join(__dirname, '..', '..', 'docs', 'MQTT_PROTOCOL.md');
const meta = require('../src/config/state_meta.json');

/** The «повний перелік subscribe keys» section, up to the next top-level heading. */
function subscribeSection(doc) {
  const start = doc.indexOf('Повний перелік subscribe keys');
  expect(start, 'the subscribe-keys section is still in the document').toBeGreaterThan(-1);
  const rest = doc.slice(start);
  const end  = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('docs/MQTT_PROTOCOL.md lists the keys the code accepts', () => {
  const doc     = fs.readFileSync(DOC, 'utf8');
  const section = subscribeSection(doc);
  const listed  = new Set([...section.matchAll(/`([a-z_]+\.[a-z0-9_.]+)`/g)].map(m => m[1]));

  it('every subscribe key of state_meta.json appears in the document', () => {
    const missing = meta.subscribeKeys.filter(k => !listed.has(k)).sort();
    expect(missing).toEqual([]);
  });

  it('the document invents no key the code would reject', () => {
    const real = new Set(meta.subscribeKeys);
    expect([...listed].filter(k => !real.has(k)).sort()).toEqual([]);
  });

  it('the count in the heading is the real one', () => {
    const claimed = section.match(/Повний перелік subscribe keys \((\d+)\s/);
    expect(claimed, 'the heading still states a count').toBeTruthy();
    expect(Number(claimed[1])).toBe(meta.subscribeKeys.length);
  });
});
