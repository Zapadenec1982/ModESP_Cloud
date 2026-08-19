'use strict';

// Route params accept either a devices.id UUID or an mqtt_device_id
// (VARCHAR(16), e.g. "EE0000000002"). They must be told apart by FORMAT:
// length is not a discriminator (mqtt ids run up to 16 chars), and comparing
// a non-UUID string against the uuid column makes Postgres throw 22P02.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidFormat(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { isUuidFormat };
