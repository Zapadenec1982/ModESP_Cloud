'use strict';

// globals: true in vitest.config.js
const { isUuidFormat } = require('../src/lib/ids');

describe('isUuidFormat', () => {
  it('accepts canonical UUIDs in either case', () => {
    expect(isUuidFormat('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isUuidFormat('123E4567-E89B-12D3-A456-426614174000')).toBe(true);
  });

  it('rejects mqtt_device_ids regardless of length', () => {
    expect(isUuidFormat('EE0000000002')).toBe(false); // 12 chars — the prod 500
    expect(isUuidFormat('ABC123')).toBe(false);
    expect(isUuidFormat('A'.repeat(16))).toBe(false);
  });

  it('rejects near-UUID garbage and non-strings', () => {
    expect(isUuidFormat('123e4567e89b12d3a456426614174000')).toBe(false); // no dashes
    expect(isUuidFormat('123e4567-e89b-12d3-a456-42661417400g')).toBe(false); // non-hex
    expect(isUuidFormat('')).toBe(false);
    expect(isUuidFormat(null)).toBe(false);
    expect(isUuidFormat(undefined)).toBe(false);
  });
});
