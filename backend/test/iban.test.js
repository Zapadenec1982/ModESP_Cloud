'use strict';

// globals: true in vitest.config.js
//
// IBAN validation (plan epic 2.2). The seller's IBAN arms automatic invoicing
// and is the account the customer pays into, so a typo must not pass: the
// checks are structure, the length the country registers, and the ISO 7064
// MOD 97-10 checksum.

const { normalizeIban, isValidIban, ibanProblem, ibanCheckDigits, LENGTHS } = require('../src/lib/iban');

describe('IBAN', () => {
  it('accepts real IBANs from the countries the platform speaks to', () => {
    for (const iban of [
      'UA213223130000026007233566001',   // Ukraine, 29
      'PL61109010140000071219812874',    // Poland, 28
      'DE89370400440532013000',          // Germany, 22
      'GB82WEST12345698765432',          // United Kingdom, letters in the BBAN
      'NO9386011117947',                 // Norway, the shortest at 15
    ]) {
      expect([iban, ibanProblem(iban)]).toEqual([iban, null]);
    }
  });

  it('normalises spaces, dashes and case to one stored form', () => {
    expect(normalizeIban('ua21 3223 1300 0002 6007 2335 6600 1')).toBe('UA213223130000026007233566001');
    expect(normalizeIban('UA21-3223-1300-0002-6007-2335-6600-1')).toBe('UA213223130000026007233566001');
    expect(normalizeIban('   ')).toBeNull();
    expect(normalizeIban(null)).toBeNull();
    expect(isValidIban('ua21 3223 1300 0002 6007 2335 6600 1')).toBe(true);
  });

  it('rejects what the old character whitelist used to accept', () => {
    expect(ibanProblem('hello world')).toBe('format');   // letters and spaces only
    expect(ibanProblem('12')).toBe('format');
    expect(ibanProblem('UA00')).toBe('format');
    expect(ibanProblem('')).toBe('format');
    expect(ibanProblem(null)).toBe('format');
  });

  it('catches a single wrong digit through the checksum', () => {
    expect(ibanProblem('UA213223130000026007233566002')).toBe('checksum');
    expect(ibanProblem('UA213223130000026007233566101')).toBe('checksum');
    expect(ibanProblem('DE89370400440532013001')).toBe('checksum');
  });

  it('holds each country to its registered length', () => {
    expect(LENGTHS.UA).toBe(29);
    expect(ibanProblem('UA21322313000002600723356600')).toBe('length');    // one short
    expect(ibanProblem('UA2132231300000260072335660011')).toBe('length');  // one long
    // An unknown country code falls back to the generic 15..34 window
    expect(ibanProblem('ZZ' + '0'.repeat(40))).toBe('length');
  });

  it('check digits round-trip: a generated IBAN validates', () => {
    const bban = '3223130000026007233566001';
    const cd = ibanCheckDigits('UA', bban);
    expect(cd).toBe('21');
    expect(isValidIban(`UA${cd}${bban}`)).toBe(true);
  });
});
