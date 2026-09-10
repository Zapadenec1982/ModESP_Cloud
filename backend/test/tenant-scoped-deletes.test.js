'use strict';

// globals: true in vitest.config.js
//
// A controller's id is not a key to one organisation.
//
// Nine tenant-scoped tables key their rows by `device_id` holding the
// controller's own six-to-twelve character id — not a UUID. That id follows the
// hardware: it is reused when a cabinet changes hands, and the previous owner's
// rows deliberately stay behind under their own tenant_id (see
// POST /devices/:id/reassign). So `WHERE device_id = $1` alone does not name one
// organisation's rows, it names every organisation that ever owned that
// controller.
//
// Three findings of the integrity audit were this same mistake: the retention
// sweep deleting across partitions (C1), the handover leaving rows nobody could
// close (H8), and the device delete erasing the previous owner's HACCP evidence
// (M6). It also costs the index — telemetry is keyed
// (tenant_id, device_id, channel, time), so without the leading column a delete
// scans every monthly partition and dies on the 30 s statement timeout.
//
// This reads the schema for the tables where `device_id` is the controller's id,
// then reads the source for DELETE statements against them.

const fs   = require('fs');
const path = require('path');
const { shutdownDb, db } = require('./helpers/setup');

const SRC = path.join(__dirname, '..', 'src');

afterAll(async () => { await shutdownDb(); });

/** Every .js under src/, with its repo-relative path. */
function sources(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('a DELETE keyed by the controller id names the organisation too', () => {
  let tables;

  beforeAll(async () => {
    const { rows } = await db.query(`
      SELECT c.table_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'device_id'
         AND c.data_type IN ('character varying', 'text')
         AND EXISTS (SELECT 1 FROM information_schema.columns t
                      WHERE t.table_schema = 'public' AND t.table_name = c.table_name
                        AND t.column_name = 'tenant_id')
       ORDER BY 1`);
    tables = rows.map(r => r.table_name);
  });

  it('finds the tables this rule is about', () => {
    // If this list shrinks to nothing the test below proves nothing, so say so.
    expect(tables).toEqual(expect.arrayContaining(['alarms', 'events', 'telemetry']));
  });

  it('no DELETE in src/ filters one of them by device_id alone', () => {
    const offenders = [];

    for (const file of sources()) {
      const text = fs.readFileSync(file, 'utf8');
      // Up to the statement's end: the closing backtick/quote, or a semicolon.
      for (const m of text.matchAll(/DELETE\s+FROM\s+([a-z_]+)([^`'";]*)/gi)) {
        const [, table, rest] = m;
        if (!tables.includes(table.toLowerCase())) continue;
        if (!/\bdevice_id\b/i.test(rest)) continue;
        if (/\btenant_id\b/i.test(rest)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(path.join(SRC, '..', '..'), file)}:${line} — DELETE FROM ${table} … ${rest.trim().slice(0, 80)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
