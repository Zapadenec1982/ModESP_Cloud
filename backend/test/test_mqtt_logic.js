'use strict';

/**
 * Unit tests for MQTT pure functions (no external services needed).
 * Run: node test/test_mqtt_logic.js
 */

const assert = require('assert');
const { parseTopic, parseScalar } = require('../src/services/mqtt');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ── parseTopic ────────────────────────────────────────────
console.log('\nparseTopic:');

test('v1 state key', () => {
  const r = parseTopic('modesp/v1/acme/F27FCD/state/equipment.air_temp');
  assert.deepStrictEqual(r, {
    tenantSlug: 'acme',
    deviceId:   'F27FCD',
    subtopic:   'state',
    stateKey:   'equipment.air_temp',
  });
});

test('v1 status', () => {
  const r = parseTopic('modesp/v1/acme/F27FCD/status');
  assert.deepStrictEqual(r, {
    tenantSlug: 'acme',
    deviceId:   'F27FCD',
    subtopic:   'status',
    stateKey:   undefined,
  });
});

test('v1 heartbeat', () => {
  const r = parseTopic('modesp/v1/acme/F27FCD/heartbeat');
  assert.deepStrictEqual(r, {
    tenantSlug: 'acme',
    deviceId:   'F27FCD',
    subtopic:   'heartbeat',
    stateKey:   undefined,
  });
});

test('v1 pending device', () => {
  const r = parseTopic('modesp/v1/pending/A4CF12/state/thermostat.setpoint');
  assert.deepStrictEqual(r, {
    tenantSlug: 'pending',
    deviceId:   'A4CF12',
    subtopic:   'state',
    stateKey:   'thermostat.setpoint',
  });
});

test('v1 cmd topic', () => {
  const r = parseTopic('modesp/v1/acme/F27FCD/cmd/thermostat.setpoint');
  assert.deepStrictEqual(r, {
    tenantSlug: 'acme',
    deviceId:   'F27FCD',
    subtopic:   'cmd',
    stateKey:   'thermostat.setpoint',
  });
});

test('legacy state key', () => {
  const r = parseTopic('modesp/A4CF12/state/equipment.air_temp');
  assert.deepStrictEqual(r, {
    tenantSlug: 'pending',
    deviceId:   'A4CF12',
    subtopic:   'state',
    stateKey:   'equipment.air_temp',
  });
});

test('legacy status', () => {
  const r = parseTopic('modesp/A4CF12/status');
  assert.deepStrictEqual(r, {
    tenantSlug: 'pending',
    deviceId:   'A4CF12',
    subtopic:   'status',
    stateKey:   undefined,
  });
});

test('invalid topic — not modesp', () => {
  const r = parseTopic('homeassistant/sensor/config');
  assert.strictEqual(r, null);
});

test('invalid topic — too short', () => {
  const r = parseTopic('modesp');
  assert.strictEqual(r, null);
});

test('v1 too short', () => {
  const r = parseTopic('modesp/v1/acme');
  assert.strictEqual(r, null);
});

// ── parseScalar ───────────────────────────────────────────
console.log('\nparseScalar:');

test('float negative', () => {
  assert.strictEqual(parseScalar('-2.50'), -2.5);
});

test('float positive', () => {
  assert.strictEqual(parseScalar('20.81'), 20.81);
});

test('integer', () => {
  assert.strictEqual(parseScalar('30'), 30);
});

test('zero', () => {
  assert.strictEqual(parseScalar('0'), 0);
});

test('bool true', () => {
  assert.strictEqual(parseScalar('true'), true);
});

test('bool false', () => {
  assert.strictEqual(parseScalar('false'), false);
});

test('string value', () => {
  assert.strictEqual(parseScalar('cooling'), 'cooling');
});

test('string "none"', () => {
  assert.strictEqual(parseScalar('none'), 'none');
});

test('string "idle"', () => {
  assert.strictEqual(parseScalar('idle'), 'idle');
});

test('empty string stays string', () => {
  assert.strictEqual(parseScalar(''), '');
});

// ── Summary ───────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
