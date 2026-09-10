'use strict';

/**
 * When an organisation is still being served.
 *
 * `tenants.status` is one of trial / active / past_due / suspended / closed
 * (migration 027). The first three are a running customer — past_due included:
 * an unpaid invoice must not switch a fridge alarm off. The last two are not:
 * a suspended organisation has been stopped deliberately, and a closed one is on
 * its way out with an export link and a purge date.
 *
 * Most background work already agreed on this and wrote the list inline. Two did
 * not check at all — the webhook queue kept POSTing a suspended customer's alarms
 * to their integration, and the offline detector kept raising alarms for them —
 * and the public status page kept showing a closed organisation's equipment, its
 * names and its temperatures, to anyone holding the link.
 *
 * The list lives here so «is this organisation still ours to serve» has one
 * answer, and adding a status later is one edit rather than a search.
 */

const SERVING = Object.freeze(['trial', 'active', 'past_due']);
const NOT_SERVING = Object.freeze(['suspended', 'closed']);

/** For a row already in hand. Unknown or missing status counts as serving:
 *  a row that predates the column must not go silent. */
function isServing(status) {
  return !NOT_SERVING.includes(String(status || 'active'));
}

/**
 * SQL for a query that joins tenants: `WHERE ... AND ${servingSql('t')}`.
 * No parameter, so it drops into a query without renumbering placeholders.
 */
function servingSql(alias = 't') {
  return `${alias}.status IN ('trial', 'active', 'past_due')`;
}

module.exports = { SERVING, NOT_SERVING, isServing, servingSql };
