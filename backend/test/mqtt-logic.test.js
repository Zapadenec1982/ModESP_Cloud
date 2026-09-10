'use strict';

// globals: true in vitest.config.js
//
// parseTopic / parseScalar — the two pure functions every measurement passes
// through on its way in. A topic that parses to the wrong organisation writes
// another tenant's telemetry; a scalar that parses to a string instead of a
// number silently stops charting.
//
// These assertions existed since early on, in test/test_mqtt_logic.js with a
// hand-rolled runner, under `npm run test:legacy` — a script CI never called
// (ci.yml runs `npm test`) and vitest.config.js explicitly excluded. So the core
// of data ingestion had 20 checks that nobody ran and nothing would report. Same
// cases, now inside the suite that actually runs.

const { parseTopic, parseScalar } = require('../src/services/mqtt');

describe('parseTopic', () => {
  it('reads the v1 topic: organisation, controller, subtopic and state key', () => {
    expect(parseTopic('modesp/v1/acme/F27FCD/state/equipment.air_temp'))
      .toEqual({ tenantSlug: 'acme', deviceId: 'F27FCD', subtopic: 'state', stateKey: 'equipment.air_temp' });
    expect(parseTopic('modesp/v1/acme/F27FCD/status'))
      .toEqual({ tenantSlug: 'acme', deviceId: 'F27FCD', subtopic: 'status', stateKey: undefined });
    expect(parseTopic('modesp/v1/acme/F27FCD/heartbeat'))
      .toEqual({ tenantSlug: 'acme', deviceId: 'F27FCD', subtopic: 'heartbeat', stateKey: undefined });
    expect(parseTopic('modesp/v1/acme/F27FCD/cmd/thermostat.setpoint'))
      .toEqual({ tenantSlug: 'acme', deviceId: 'F27FCD', subtopic: 'cmd', stateKey: 'thermostat.setpoint' });
  });

  it('a controller with no organisation yet publishes under «pending»', () => {
    expect(parseTopic('modesp/v1/pending/A4CF12/state/thermostat.setpoint'))
      .toEqual({ tenantSlug: 'pending', deviceId: 'A4CF12', subtopic: 'state', stateKey: 'thermostat.setpoint' });
  });

  it('the pre-v1 topic still parses, and lands in «pending»', () => {
    expect(parseTopic('modesp/A4CF12/state/equipment.air_temp'))
      .toEqual({ tenantSlug: 'pending', deviceId: 'A4CF12', subtopic: 'state', stateKey: 'equipment.air_temp' });
    expect(parseTopic('modesp/A4CF12/status'))
      .toEqual({ tenantSlug: 'pending', deviceId: 'A4CF12', subtopic: 'status', stateKey: undefined });
  });

  it('anything that is not ours, or is too short to name a device, is null', () => {
    expect(parseTopic('homeassistant/sensor/config')).toBeNull();
    expect(parseTopic('modesp')).toBeNull();
    expect(parseTopic('modesp/v1/acme')).toBeNull();
  });
});

describe('parseScalar', () => {
  it('reads numbers as numbers', () => {
    expect(parseScalar('-2.50')).toBe(-2.5);
    expect(parseScalar('20.81')).toBe(20.81);
    expect(parseScalar('30')).toBe(30);
    expect(parseScalar('0')).toBe(0);
  });

  it('reads the two booleans as booleans', () => {
    expect(parseScalar('true')).toBe(true);
    expect(parseScalar('false')).toBe(false);
  });

  it('leaves everything else a string, empty one included', () => {
    expect(parseScalar('cooling')).toBe('cooling');
    expect(parseScalar('none')).toBe('none');
    expect(parseScalar('idle')).toBe('idle');
    expect(parseScalar('')).toBe('');
  });
});
