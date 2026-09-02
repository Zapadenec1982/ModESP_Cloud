'use strict';

/**
 * Claim codes for pending controllers (plan epic 1.7).
 *
 * A pending device is visible to the superadmin only until an organisation
 * admin types the code printed on the controller (POST /devices/claim). The
 * firmware may report its factory-printed code at registration; devices that
 * register without one get a generated code the superadmin can hand over.
 *
 * Alphabet omits 0/O/1/I so a code read off a label is not ambiguous.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLAIM_CODE_LENGTH = 8;
const CLAIM_CODE_RE = /^[A-Z0-9]{6,12}$/;

function generateClaimCode(length = CLAIM_CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Uppercase, strip spaces/dashes; null when what remains is not a plausible code. */
function normalizeClaimCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return CLAIM_CODE_RE.test(code) ? code : null;
}

module.exports = { generateClaimCode, normalizeClaimCode, CLAIM_CODE_LENGTH, CLAIM_CODE_RE };
