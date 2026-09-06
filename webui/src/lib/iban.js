/**
 * IBAN check for the billing form (plan epic 2.2).
 *
 * Catches a typo before the round trip: structure plus the ISO 7064 MOD 97-10
 * checksum, which is what makes a one-digit slip detectable. The per-country
 * length registry deliberately lives only on the server
 * (backend/src/lib/iban.js), so there is one authority and nothing to keep in
 * step here; the server is what actually accepts or rejects the value.
 */

/** Storage form: no spaces or dashes, upper case. */
export function normalizeIban(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

function mod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

/** True for an empty value too: "not filled" is a separate state from "wrong". */
export function looksLikeIban(value) {
  const iban = normalizeIban(value);
  if (!iban) return true;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length < 15 || iban.length > 34) return false;
  return mod97(iban) === 1;
}
