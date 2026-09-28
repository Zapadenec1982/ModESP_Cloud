'use strict';

/**
 * Yield to the event loop until cond() holds, or give up after a wall-clock
 * deadline. The deadline is time, not a number of turns: the work these tests
 * wait on (an alarm insert behind a fired timer, a backfill landing) is several
 * queries on a database the other test workers share, and on a loaded CI runner
 * 200 turns were over before it finished — the row then arrived during the next
 * test and was counted there (alarm-restart, CI run 36396007032). hrtime is the
 * clock because the callers fake Date or setTimeout; nothing fakes hrtime.
 *
 * @param {() => (Promise<boolean>|boolean)} cond
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<boolean>} whether cond() held before the deadline
 */
async function waitFor(cond, timeoutMs = 10_000) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  do {
    if (await cond()) return true;
    await new Promise(r => setImmediate(r));
  } while (process.hrtime.bigint() < deadline);
  return false;
}

module.exports = { waitFor };
