'use strict';

/**
 * Getting-started checklist (plan epic 2.1).
 *
 * Five steps a new organisation walks through before the platform is useful
 * to it: a site, a connected controller, a second person, a Telegram link and
 * a first HACCP report. Each step is read from the data itself, so nothing
 * has to be "ticked" — the first time a step is seen done its timestamp is
 * written to tenant_settings.onboarding, which is also where the dismissal
 * lives. Administrators of the organisation only (mounted behind
 * authorize('admin')).
 *
 *   GET  /api/onboarding          steps, progress, trial status
 *   POST /api/onboarding/dismiss  hide the card on the dashboard
 */

const { Router } = require('express');
const db = require('../services/db');

const router = Router();

const STEPS = ['site', 'device', 'team', 'telegram', 'report'];

async function snapshot(tenantId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sites s WHERE s.tenant_id = $1) AS sites,
       (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = $1 AND d.status = 'active' AND d.deleted_at IS NULL) AS devices,
       (SELECT COUNT(*)::int FROM user_tenants ut JOIN users u ON u.id = ut.user_id
         WHERE ut.tenant_id = $1 AND u.active = true AND u.role <> 'superadmin') AS members,
       (SELECT COUNT(*)::int FROM invitations i WHERE i.tenant_id = $1 AND i.revoked_at IS NULL) AS invitations,
       (SELECT COUNT(*)::int FROM user_tenants ut JOIN users u ON u.id = ut.user_id
         WHERE ut.tenant_id = $1 AND u.telegram_id IS NOT NULL) AS telegram_users,
       (SELECT COUNT(*)::int FROM notification_subscribers n
         WHERE n.tenant_id = $1 AND n.channel = 'telegram' AND n.active = true) AS telegram_subscribers,
       (SELECT COUNT(*)::int FROM report_exports r WHERE r.tenant_id = $1) AS reports,
       t.status, t.trial_expires_at, t.registered_at,
       COALESCE(s.onboarding, '{}'::jsonb) AS onboarding
     FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId]);
  return rows[0] || null;
}

function stepsOf(snap) {
  return {
    site:     snap.sites > 0,
    device:   snap.devices > 0,
    team:     snap.members > 1 || snap.invitations > 0,
    telegram: snap.telegram_users > 0 || snap.telegram_subscribers > 0,
    report:   snap.reports > 0,
  };
}

/** Read the checklist and record the steps first seen done. */
async function checklist(tenantId, { now = new Date() } = {}) {
  const snap = await snapshot(tenantId);
  if (!snap) return null;
  const done = stepsOf(snap);
  const stored = (snap.onboarding && typeof snap.onboarding === 'object') ? snap.onboarding : {};
  const steps = { ...(stored.steps || {}) };
  let changed = false;
  for (const key of STEPS) {
    if (done[key] && !steps[key]) { steps[key] = now.toISOString(); changed = true; }
  }
  if (changed) {
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, onboarding) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET onboarding = COALESCE(tenant_settings.onboarding, '{}'::jsonb) || $2::jsonb`,
      [tenantId, JSON.stringify({ steps })]);
  }
  const list = STEPS.map(key => ({ key, done: !!done[key], done_at: done[key] ? (steps[key] || null) : null }));
  const doneCount = list.filter(s => s.done).length;
  const trialEnd = snap.trial_expires_at ? new Date(snap.trial_expires_at) : null;
  return {
    steps: list,
    done_count: doneCount,
    total: STEPS.length,
    completed: doneCount === STEPS.length,
    dismissed_at: stored.dismissed_at || null,
    trial: {
      status: snap.status,
      trial_expires_at: snap.trial_expires_at,
      days_left: snap.status === 'trial' && trialEnd ? Math.max(0, Math.ceil((trialEnd - now) / 86_400_000)) : null,
    },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const data = await checklist(req.tenantId);
    if (!data) return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post('/dismiss', async (req, res, next) => {
  try {
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, onboarding) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET onboarding = COALESCE(tenant_settings.onboarding, '{}'::jsonb) || $2::jsonb`,
      [req.tenantId, JSON.stringify({ dismissed_at: new Date().toISOString(), dismissed_by: req.user ? req.user.id : null })]);
    req.auditContext = { entityId: req.tenantId, action: 'onboarding.dismiss' };
    const data = await checklist(req.tenantId);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.STEPS = STEPS;
module.exports.checklist = checklist;
