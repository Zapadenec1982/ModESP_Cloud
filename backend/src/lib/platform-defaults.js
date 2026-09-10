'use strict';

/**
 * Platform-wide defaults, read from the environment exactly once.
 *
 * Each of these numbers used to be written in several places, and only some of
 * them read the environment. The consequences were not cosmetic:
 *
 *   • DOOR_ALARM_DELAY_MS — services/mqtt.js waits it out before recording a door
 *     alarm, routes/tenants.js reports it as the organisation's setting, and the
 *     HACCP report prints it as the rule the document was judged by. The report
 *     had its own copy. Set the variable to five minutes and the platform alarmed
 *     after five while the certified PDF still told the inspector «doors > 10 min».
 *
 *   • HACCP_EXCURSION_MIN — the same shape: the settings API from the environment,
 *     the report from a constant of its own.
 *
 *   • HOURLY_RETENTION_DAYS — scripts/cleanup-telemetry.js deletes by it, and the
 *     report both compared against a copy and spelled «3 роки» into the sentence
 *     the inspector reads, in four languages. Lower the retention and the document
 *     promises an archive that is no longer there.
 *
 * A per-organisation override still wins where one exists (tenant_settings,
 * sites.haccp_excursion_min). This module is only the floor under them: the value
 * the platform uses when nobody has said otherwise.
 *
 * Read at require time, like every other config in this codebase — the processes
 * that use these are restarted on deploy, and a value that can change under a
 * running report is worse than one that cannot.
 */

/** A positive integer from the environment, else the fallback. */
function intFromEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How long a door may stand open before the platform calls it an alarm. */
const DOOR_ALARM_DELAY_MS = intFromEnv('DOOR_ALARM_DELAY_MS', 600_000);

/** How long a temperature may stay past the critical limit before it is an excursion. */
const HACCP_EXCURSION_MIN = intFromEnv('HACCP_EXCURSION_MIN', 30);

/** How long the hourly archive is kept — the «three years» the HACCP report promises. */
const HOURLY_RETENTION_DAYS = intFromEnv('HOURLY_RETENTION_DAYS', 1095);

/** Whole years, for the sentence the inspector reads. 1095 → 3. */
function hourlyRetentionYears() {
  return Math.round((HOURLY_RETENTION_DAYS / 365) * 10) / 10;
}

module.exports = {
  DOOR_ALARM_DELAY_MS,
  HACCP_EXCURSION_MIN,
  HOURLY_RETENTION_DAYS,
  hourlyRetentionYears,
  intFromEnv,
};
