'use strict';

/**
 * IBAN validation (plan epic 2.2).
 *
 * The seller's IBAN is not decoration: since the billing safety gates it is
 * what arms automatic invoicing, and it is the account the customer copies
 * into the bank transfer. A typo there means invoices nobody can pay, so the
 * value is checked the way a bank checks it — structure, the length the
 * country registers, and the ISO 7064 MOD 97-10 checksum — not merely for
 * plausible characters.
 *
 * ISO 13616. Ukraine is 29 characters (UA + 2 check digits + 25).
 */

/** Registered IBAN length per country (ISO 13616 registry). */
const LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28,
  PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24,
  SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
};

const MIN_LENGTH = 15;
const MAX_LENGTH = 34;

/** Storage form: no spaces, upper case. `UA21 3223 …` and `ua213223…` become one value. */
function normalizeIban(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).replace(/[\s -]/g, '').toUpperCase();
  return v || null;
}

/** ISO 7064 MOD 97-10 over the rearranged string; a valid IBAN leaves 1. */
function mod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    // 'A'..'Z' → 10..35, '0'..'9' → 0..9
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

/**
 * Why this value is not an IBAN, or null when it is one.
 * @returns {'format'|'length'|'checksum'|null}
 */
function ibanProblem(value) {
  const iban = normalizeIban(value);
  if (!iban) return 'format';
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return 'format';
  const expected = LENGTHS[iban.slice(0, 2)];
  if (expected ? iban.length !== expected : (iban.length < MIN_LENGTH || iban.length > MAX_LENGTH)) return 'length';
  if (mod97(iban) !== 1) return 'checksum';
  return null;
}

function isValidIban(value) {
  return ibanProblem(value) === null;
}

/** The check digits that make `countryCode + BBAN` a valid IBAN (used by tests and seeds). */
function ibanCheckDigits(countryCode, bban) {
  const body = `${String(bban).toUpperCase()}${String(countryCode).toUpperCase()}00`;
  let remainder = 0;
  for (const ch of body) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return String(98 - remainder).padStart(2, '0');
}

module.exports = { normalizeIban, isValidIban, ibanProblem, ibanCheckDigits, LENGTHS, MIN_LENGTH, MAX_LENGTH };
