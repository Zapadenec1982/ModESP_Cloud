'use strict';

/**
 * Getting-started checklist (plan epic 2.1; the first-run chain of product
 * audit item 8).
 *
 * Seven steps a new organisation walks through before the platform is useful
 * to it, in the order the work actually happens: a site, a connected
 * controller, its first data, a second person, someone responsible for the
 * equipment, a notification that was really delivered, and a first HACCP
 * report. Each step is read from the data itself, so nothing has to be
 * "ticked" — the first time a step is seen done its timestamp is written to
 * tenant_settings.onboarding, which is also where the dismissal lives.
 * Administrators of the organisation only (mounted behind authorize('admin')).
 *
 *   GET  /api/onboarding          steps, the next one, progress, trial status
 *   POST /api/onboarding/dismiss  hide the card on the dashboard
 *   POST /api/onboarding/restore  show it again (from the «Початок роботи» page)
 */

const { Router } = require('express');
const db = require('../services/db');

const router = Router();

const STEPS = ['site', 'device', 'data', 'team', 'responsible', 'notify', 'report'];

async function snapshot(tenantId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sites s WHERE s.tenant_id = $1) AS sites,
       (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = $1 AND d.status = 'active' AND d.deleted_at IS NULL) AS devices,
       -- last_seen is stamped by the first message a controller sends: its first measurement
       (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = $1 AND d.status = 'active' AND d.deleted_at IS NULL
         AND d.last_seen IS NOT NULL) AS reporting,
       (SELECT COUNT(*)::int FROM user_tenants ut JOIN users u ON u.id = ut.user_id
         WHERE ut.tenant_id = $1 AND u.active = true AND u.role <> 'superadmin') AS members,
       (SELECT COUNT(*)::int FROM invitations i WHERE i.tenant_id = $1 AND i.revoked_at IS NULL) AS invitations,
       -- Somebody answers for the equipment: a contact person on a site, a technician
       -- or admin who was given a site or a device, or a work order with an assignee
       (EXISTS (SELECT 1 FROM sites s WHERE s.tenant_id = $1
                 AND (NULLIF(btrim(s.contact_name), '') IS NOT NULL OR NULLIF(btrim(s.contact_phone), '') IS NOT NULL))
        OR EXISTS (SELECT 1 FROM user_sites us JOIN user_tenants ut ON ut.user_id = us.user_id AND ut.tenant_id = us.tenant_id
                    JOIN users u ON u.id = us.user_id
                   WHERE us.tenant_id = $1 AND u.active = true AND ut.role IN ('technician', 'admin'))
        OR EXISTS (SELECT 1 FROM user_devices ud JOIN devices d ON d.id = ud.device_id
                    JOIN user_tenants ut ON ut.user_id = ud.user_id AND ut.tenant_id = d.tenant_id
                    JOIN users u ON u.id = ud.user_id
                   WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND u.active = true AND ut.role IN ('technician', 'admin'))
        OR EXISTS (SELECT 1 FROM work_orders w WHERE w.tenant_id = $1 AND w.assigned_to IS NOT NULL)) AS responsible,
       -- A channel that was linked but never reached anyone is not a working channel:
       -- only a delivery counts, a real alarm or the test the notifications page sends
       EXISTS (SELECT 1 FROM notification_log n WHERE n.tenant_id = $1 AND n.status = 'sent') AS delivered,
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
    site:        snap.sites > 0,
    device:      snap.devices > 0,
    data:        snap.reporting > 0,
    team:        snap.members > 1 || snap.invitations > 0,
    responsible: !!snap.responsible,
    notify:      !!snap.delivered,
    report:      snap.reports > 0,
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
  const next = list.find(s => !s.done);
  const trialEnd = snap.trial_expires_at ? new Date(snap.trial_expires_at) : null;
  return {
    steps: list,
    next: next ? next.key : null,
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

/** Merge a patch into tenant_settings.onboarding (the row may not exist yet). */
function patchOnboarding(tenantId, patch) {
  return db.query(
    `INSERT INTO tenant_settings (tenant_id, onboarding) VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET onboarding = COALESCE(tenant_settings.onboarding, '{}'::jsonb) || $2::jsonb`,
    [tenantId, JSON.stringify(patch)]);
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
    await patchOnboarding(req.tenantId, { dismissed_at: new Date().toISOString(), dismissed_by: req.user ? req.user.id : null });
    req.auditContext = { entityId: req.tenantId, action: 'onboarding.dismiss' };
    const data = await checklist(req.tenantId);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// The card comes back on the dashboard; the progress was never lost
router.post('/restore', async (req, res, next) => {
  try {
    await patchOnboarding(req.tenantId, { dismissed_at: null, dismissed_by: null });
    req.auditContext = { entityId: req.tenantId, action: 'onboarding.restore' };
    const data = await checklist(req.tenantId);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.STEPS = STEPS;
module.exports.checklist = checklist;
