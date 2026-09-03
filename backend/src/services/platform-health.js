'use strict';

/**
 * Platform self-checks behind GET /api/health.
 *
 * Three things go wrong silently on a single-VPS deployment and are invisible to
 * an external "is the API up" probe: the nightly backup stops running, the
 * telemetry partitions run out (INSERTs start failing on the 1st of the month),
 * and the disk fills up with firmware images or archives. Each check here is
 * cheap, cached for a minute, and summarised to a categorical status so the
 * public health endpoint can expose it without leaking numbers; the numbers
 * themselves are served to superadmins only (GET /api/health/details).
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const db   = require('./db');

const CACHE_MS = 60_000;
const PARTITION_RE = /^telemetry_(\d{4})_(\d{2})$/;

let cache = { at: 0, value: null };

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaults() {
  return {
    backupDir:         process.env.BACKUP_DIR || '/var/backups/modesp',
    backupMaxAgeHours: envInt('BACKUP_MAX_AGE_HOURS', 48),
    diskPath:          process.env.FIRMWARE_STORAGE_PATH
                         ? path.resolve(process.cwd(), process.env.FIRMWARE_STORAGE_PATH)
                         : process.cwd(),
    diskMinFreePct:    envInt('DISK_MIN_FREE_PCT', 10),
  };
}

/**
 * Age of the last successful backup, from the marker backup-postgres.sh writes.
 * @returns {Promise<{status:'ok'|'stale'|'unknown', marker:string, age_hours:number|null, archive?:string, archive_bytes?:number, db_size_bytes?:number, offsite?:string, timestamp?:string}>}
 */
async function backupCheck({ now = new Date(), backupDir, maxAgeHours } = {}) {
  const d = defaults();
  const marker = path.join(backupDir || d.backupDir, 'last-success');
  const limit  = maxAgeHours || d.backupMaxAgeHours;
  let text;
  try {
    text = await fsp.readFile(marker, 'utf8');
  } catch {
    return { status: 'unknown', marker, age_hours: null };
  }
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const ts = Date.parse(kv.timestamp);
  if (!Number.isFinite(ts)) return { status: 'unknown', marker, age_hours: null };

  const ageHours = Math.max(0, (now.getTime() - ts) / 3_600_000);
  return {
    status:        ageHours <= limit ? 'ok' : 'stale',
    marker,
    timestamp:     kv.timestamp,
    age_hours:     Math.round(ageHours * 10) / 10,
    max_age_hours: limit,
    archive:       kv.archive,
    archive_bytes: parseInt(kv.archive_bytes, 10) || null,
    db_size_bytes: parseInt(kv.db_size_bytes, 10) || null,
    offsite:       kv.offsite,
  };
}

/**
 * How many months of telemetry partitions exist beyond the current one.
 * A DEFAULT partition (test databases) counts as coverage.
 */
async function partitionCheck({ now = new Date(), query } = {}) {
  const q = query || ((sql, params) => db.query(sql, params));
  let rows;
  try {
    ({ rows } = await q(`
      SELECT inhrelid::regclass::text AS name
        FROM pg_inherits
       WHERE inhparent = 'telemetry'::regclass`));
  } catch (err) {
    return { status: 'unknown', error: err.message, ahead_months: null, count: 0, has_default: false, last_partition: null };
  }

  let hasDefault = false;
  let last = null;   // { year, month, name }
  for (const { name } of rows) {
    if (name === 'telemetry_default') { hasDefault = true; continue; }
    const m = name.match(PARTITION_RE);
    if (!m) continue;
    const year = parseInt(m[1], 10), month = parseInt(m[2], 10);
    if (!last || year > last.year || (year === last.year && month > last.month)) {
      last = { year, month, name };
    }
  }

  const aheadMonths = last
    ? (last.year - now.getFullYear()) * 12 + (last.month - (now.getMonth() + 1))
    : null;
  const covered = hasDefault || (aheadMonths !== null && aheadMonths >= 1);
  return {
    status:         covered ? 'ok' : 'low',
    ahead_months:   aheadMonths,
    count:          rows.length,
    has_default:    hasDefault,
    last_partition: last ? last.name : null,
  };
}

/**
 * Free space on the filesystem holding the firmware store (or the backend dir).
 */
async function diskCheck({ diskPath, minFreePct } = {}) {
  const d = defaults();
  const target = diskPath || d.diskPath;
  const limit  = minFreePct || d.diskMinFreePct;
  let probe = target;
  if (!fs.existsSync(probe)) probe = path.dirname(probe);
  try {
    const st = await fsp.statfs(probe);
    const total = Number(st.blocks) * Number(st.bsize);
    const free  = Number(st.bavail) * Number(st.bsize);
    const pct   = total > 0 ? Math.round((free / total) * 1000) / 10 : null;
    return {
      status:      pct === null ? 'unknown' : (pct >= limit ? 'ok' : 'low'),
      path:        probe,
      free_pct:    pct,
      free_bytes:  free,
      total_bytes: total,
      min_free_pct: limit,
    };
  } catch (err) {
    return { status: 'unknown', path: probe, error: err.message, free_pct: null };
  }
}

/**
 * Run all checks (cached for CACHE_MS unless fresh=true).
 */
async function collect({ fresh = false, now = new Date(), query, backupDir, diskPath } = {}) {
  if (!fresh && cache.value && now.getTime() - cache.at < CACHE_MS) return cache.value;
  const [backup, partitions, disk] = await Promise.all([
    backupCheck({ now, backupDir }),
    partitionCheck({ now, query }),
    diskCheck({ diskPath }),
  ]);
  const value = { backup, partitions, disk };
  cache = { at: now.getTime(), value };
  return value;
}

/** Categorical summary for the public endpoint. */
function summarize(checks) {
  if (!checks) {
    return { platform: 'unknown', checks: { backup: 'unknown', partitions: 'unknown', disk: 'unknown' } };
  }
  const statuses = {
    backup:     checks.backup.status,
    partitions: checks.partitions.status,
    disk:       checks.disk.status,
  };
  const failing = Object.values(statuses).some(s => s === 'stale' || s === 'low');
  return { platform: failing ? 'attention' : 'ok', checks: statuses };
}

function resetCache() { cache = { at: 0, value: null }; }

module.exports = { collect, summarize, backupCheck, partitionCheck, diskCheck, resetCache };
