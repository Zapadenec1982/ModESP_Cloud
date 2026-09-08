'use strict';

/**
 * API keys of the organisation (plan epic 2.6). Mounted with authorize('admin').
 *   GET    /api-keys        list (prefix, scope, last use — never the key)
 *   POST   /api-keys        create; the key is in the answer once
 *   DELETE /api-keys/:id    revoke
 */

const { Router } = require('express');
const { z } = require('zod');
const apiKeys = require('../services/api-keys');
const { requireFeature } = require('../middleware/plan');
const { isUuidFormat } = require('../lib/ids');

const router = Router();
const MAX_ACTIVE = 20;

const createSchema = z.object({
  name:            z.string().trim().min(1).max(80),
  scope:           z.enum(apiKeys.SCOPES).optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

router.get('/', async (req, res) => {
  try {
    res.json({ data: await apiKeys.list(req.tenantId) });
  } catch (err) {
    req.log?.error?.({ err }, 'List API keys failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list API keys', status: 500 });
  }
});

router.post('/', requireFeature('api'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const active = (await apiKeys.list(req.tenantId)).filter(k => k.active).length;
    if (active >= MAX_ACTIVE) {
      return res.status(409).json({ error: 'limit_reached', message: `At most ${MAX_ACTIVE} active API keys per organisation`, status: 409 });
    }
    const b = parsed.data;
    const expiresAt = b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86_400_000) : null;
    const { key, row } = await apiKeys.create({ tenantId: req.tenantId, name: b.name, scope: b.scope || 'read', expiresAt, createdBy: req.user.id });
    req.auditContext = { entityId: row.id, action: 'api_key.create', changes: { name: row.name, scope: row.scope, prefix: row.prefix, expires_at: expiresAt } };
    res.status(201).json({ data: { ...row, active: true, key } });
  } catch (err) {
    req.log?.error?.({ err }, 'Create API key failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to create API key', status: 500 });
  }
});

router.delete('/:id', async (req, res) => {
  if (!isUuidFormat(req.params.id)) return res.status(404).json({ error: 'not_found', message: 'API key not found', status: 404 });
  try {
    const row = await apiKeys.revoke(req.tenantId, req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'API key not found', status: 404 });
    req.auditContext = { entityId: row.id, action: 'api_key.revoke', changes: { name: row.name, prefix: row.prefix } };
    res.json({ data: { ...row, active: false } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke API key failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke API key', status: 500 });
  }
});

module.exports = router;
