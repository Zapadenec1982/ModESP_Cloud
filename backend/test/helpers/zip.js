'use strict';

// A small reader for the zip files the data export produces (no zip64):
// walks the central directory and inflates one entry on demand.

const zlib = require('zlib');

function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + n).toString('utf8');
    out.push({ name, method, compressedSize, size, offset });
    p += 46 + n + m + k;
  }
  return out;
}

function read(buf, name) {
  const e = entries(buf).find(x => x.name === name);
  if (!e) throw new Error(`no entry ${name}`);
  const lh = e.offset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header');
  const n = buf.readUInt16LE(lh + 26), m = buf.readUInt16LE(lh + 28);
  const data = buf.slice(lh + 30 + n + m, lh + 30 + n + m + e.compressedSize);
  return e.method === 8 ? zlib.inflateRawSync(data) : data;
}

module.exports = { entries, read };
