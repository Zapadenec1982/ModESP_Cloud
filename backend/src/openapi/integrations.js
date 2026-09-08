'use strict';

/** API keys, webhooks and the outbound webhook events (plan epic 2.6). */

const apiKeys = require('../services/api-keys');
const webhooks = require('../services/webhooks');

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const ADMIN_ONLY = { security: [{ userToken: [] }] };
  const keyOnlyNote = 'Administrator with a user token; closed to API keys (`403 api_key_scope`).';

  // ── API keys ──
  const ApiKey = registry.register('ApiKey', z.object({
    id: uuid,
    name: z.string().openapi({ example: 'CMMS' }),
    prefix: z.string().openapi({ example: 'modesp_5gtt3Nrz', description: 'First 15 characters — enough to recognise the key in a list' }),
    scope: z.enum(apiKeys.SCOPES),
    created_by: uuid.nullable(),
    created_at: isoDate,
    last_used_at: isoDate.nullable().openapi({ description: 'Updated at most once a minute' }),
    expires_at: isoDate.nullable(),
    revoked_at: isoDate.nullable(),
    active: z.boolean(),
  }));
  const ApiKeyCreated = registry.register('ApiKeyCreated', ApiKey.extend({
    key: z.string().openapi({ example: 'modesp_5gtt3Nrz_LksgTbxNXpjjwksizz15aKKohJ7d0YbmXg', description: 'The full key. Shown once; only its SHA-256 is stored.' }),
  }));

  registry.registerPath({
    method: 'get', path: '/api-keys', tags: ['API keys'], summary: 'List the organisation\'s API keys', description: keyOnlyNote, ...ADMIN_ONLY,
    responses: withCommon({ 200: listOf(ApiKey, 'Keys, newest first; never the secret') }),
  });
  registry.registerPath({
    method: 'post', path: '/api-keys', tags: ['API keys'], summary: 'Create an API key', description: keyOnlyNote + ' Plan feature `api`.', ...ADMIN_ONLY,
    request: { body: { content: { 'application/json': { schema: z.object({
      name: z.string().trim().min(1).max(80).openapi({ example: 'CMMS' }),
      scope: z.enum(apiKeys.SCOPES).optional().openapi({ description: '`read` (default) → viewer, `write` → technician, `admin` → admin' }),
      expires_in_days: z.number().int().min(1).max(3650).optional().openapi({ example: 90 }),
    }) } } } },
    responses: withCommon({
      201: dataOf(ApiKeyCreated, 'The key, with `key` shown once'),
      400: errorOf('`validation_failed`'),
      402: errorOf('`plan_feature`: the plan has no `api` feature'),
      409: errorOf('`limit_reached`: 20 active keys already'),
    }),
  });
  registry.registerPath({
    method: 'delete', path: '/api-keys/{id}', tags: ['API keys'], summary: 'Revoke an API key', description: keyOnlyNote + ' Systems using the key get `401` from the next request on.', ...ADMIN_ONLY,
    request: { params: z.object({ id: uuid }) },
    responses: withCommon({ 200: dataOf(ApiKey, 'The revoked key'), 404: errorOf('`not_found`') }),
  });

  // ── Webhooks ──
  const Event = z.enum([...webhooks.EVENTS, '*']).openapi('WebhookEvent', { description: 'Subscribable events; `*` means all of them' });
  const Webhook = registry.register('Webhook', z.object({
    id: uuid,
    name: z.string().openapi({ example: 'CMMS' }),
    url: z.string().url().openapi({ example: 'https://cmms.example.com/modesp/webhook' }),
    events: z.array(Event),
    enabled: z.boolean(),
    failures: z.number().int().openapi({ description: 'Failures in a row; 10 switch the hook off' }),
    disabled_at: isoDate.nullable(),
    disabled_reason: z.enum(['manual', 'failures']).nullable(),
    last_delivery_at: isoDate.nullable(),
    last_status: z.number().int().nullable().openapi({ description: 'HTTP status of the last attempt, null when the target did not answer' }),
    created_by: uuid.nullable(),
    created_at: isoDate,
    updated_at: isoDate,
    pending: z.number().int().openapi({ description: 'Deliveries waiting for an attempt' }),
    dead: z.number().int().openapi({ description: 'Deliveries given up after 5 attempts' }),
  }));
  const WebhookCreated = registry.register('WebhookCreated', Webhook.extend({
    secret: z.string().openapi({ example: 'xQhPOHCygtcpfTnWZ366ZFjEbKpc_X6LPspQeIPJFR0', description: 'The signing secret. Shown once; stored encrypted.' }),
  }));
  const Delivery = registry.register('WebhookDelivery', z.object({
    id: uuid.openapi({ description: 'Also sent as `X-ModESP-Delivery`; the same on every retry' }),
    event: z.string().openapi({ example: 'alarm.raised' }),
    status: z.enum(['pending', 'ok', 'failed', 'dead']),
    attempts: z.number().int(),
    next_attempt_at: isoDate.nullable(),
    status_code: z.number().int().nullable(),
    error: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    created_at: isoDate,
    delivered_at: isoDate.nullable(),
    payload: z.record(z.any()).openapi({ description: 'The body that was (or will be) posted' }),
  }));
  const hookBody = z.object({
    name: z.string().trim().min(1).max(80).openapi({ example: 'CMMS' }),
    url: z.string().trim().url().max(2048).openapi({ example: 'https://cmms.example.com/modesp/webhook', description: 'Public http(s) only, no credentials; private, loopback and link-local hosts (also via DNS) are refused' }),
    events: z.array(Event).min(1).max(20),
    secret: z.string().min(16).max(128).optional().openapi({ description: 'Your own signing secret; generated when omitted' }),
    enabled: z.boolean().optional(),
  });
  const hookParam = z.object({ id: uuid });

  registry.registerPath({
    method: 'get', path: '/webhooks', tags: ['Webhooks'], summary: 'List webhooks with queue counters', description: keyOnlyNote, ...ADMIN_ONLY,
    responses: withCommon({ 200: listOf(Webhook, 'Webhooks in creation order', z.object({ events: z.array(z.string()) })) }),
  });
  registry.registerPath({
    method: 'post', path: '/webhooks', tags: ['Webhooks'], summary: 'Create a webhook', description: keyOnlyNote + ' Plan feature `api`. At most 10 per organisation.', ...ADMIN_ONLY,
    request: { body: { content: { 'application/json': { schema: hookBody } } } },
    responses: withCommon({
      201: dataOf(WebhookCreated, 'The webhook, with `secret` shown once'),
      400: errorOf('`validation_failed` or `invalid_url`'),
      402: errorOf('`plan_feature`'),
      409: errorOf('`limit_reached`'),
    }),
  });
  registry.registerPath({
    method: 'patch', path: '/webhooks/{id}', tags: ['Webhooks'], summary: 'Change name, target, events or state', description: keyOnlyNote + ' Re-enabling resets the failure counter.', ...ADMIN_ONLY,
    request: { params: hookParam, body: { content: { 'application/json': { schema: hookBody.partial() } } } },
    responses: withCommon({ 200: dataOf(Webhook, 'The updated webhook'), 400: errorOf('`validation_failed` or `invalid_url`'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'delete', path: '/webhooks/{id}', tags: ['Webhooks'], summary: 'Delete a webhook and its delivery log', description: keyOnlyNote, ...ADMIN_ONLY,
    request: { params: hookParam },
    responses: withCommon({ 200: dataOf(z.object({ deleted: z.literal(true) }), 'Deleted'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'post', path: '/webhooks/{id}/test', tags: ['Webhooks'], summary: 'Send a `ping` event now', description: keyOnlyNote, ...ADMIN_ONLY,
    request: { params: hookParam },
    responses: withCommon({ 200: dataOf(z.object({ ok: z.boolean(), status_code: z.number().int().nullable(), error: z.string().nullable(), duration_ms: z.number().int() }), 'What the target answered'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'post', path: '/webhooks/{id}/rotate-secret', tags: ['Webhooks'], summary: 'Replace the signing secret', description: keyOnlyNote + ' The old secret stops working at once.', ...ADMIN_ONLY,
    request: { params: hookParam },
    responses: withCommon({ 200: dataOf(z.object({ id: uuid, secret: z.string() }), 'The new secret, shown once'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'get', path: '/webhooks/{id}/deliveries', tags: ['Webhooks'], summary: 'Recent deliveries', description: keyOnlyNote, ...ADMIN_ONLY,
    request: { params: hookParam, query: z.object({
      limit: z.number().int().min(1).max(200).optional().openapi({ example: 50 }),
      status: z.enum(['pending', 'ok', 'failed', 'dead']).optional(),
    }) },
    responses: withCommon({ 200: listOf(Delivery, 'Newest first'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'post', path: '/webhooks/{id}/deliveries/{did}/redeliver', tags: ['Webhooks'], summary: 'Queue a delivery again', description: keyOnlyNote + ' Works for `ok`, `failed` and `dead`; the copy carries `redelivery_of`.', ...ADMIN_ONLY,
    request: { params: z.object({ id: uuid, did: uuid }) },
    responses: withCommon({ 202: dataOf(z.object({ id: uuid }), 'The new delivery id'), 404: errorOf('`not_found`') }),
  });

  // ── Outbound events (OpenAPI 3.1 webhooks) ──
  const base = {
    device_id: mqttId.nullable(),
    device_uuid: uuid.nullable(),
    device_name: z.string().nullable().openapi({ example: 'Freezer cabinet 3' }),
    site_id: uuid.nullable(),
    site_name: z.string().nullable().openapi({ example: 'Store №212' }),
  };
  const envelope = (event, data, example) => z.object({
    id: uuid.openapi({ description: 'Delivery id, also in `X-ModESP-Delivery`' }),
    event: z.literal(event),
    created_at: isoDate,
    tenant_id: uuid,
    data: data.openapi({ example }),
  });
  const HEADERS = z.object({
    'X-ModESP-Event': z.string().openapi({ description: 'The event name', example: 'alarm.raised' }),
    'X-ModESP-Delivery': uuid.openapi({ description: 'Delivery id — deduplicate on it, retries repeat it' }),
    'X-ModESP-Timestamp': z.string().openapi({ description: 'Unix seconds when this attempt was signed; reject stale ones (> 5 min)', example: '1788900809' }),
    'X-ModESP-Signature': z.string().openapi({ description: '`v1=` + hex HMAC-SHA256 over `"<timestamp>.<raw body>"` with the webhook secret', example: 'v1=3f1c…' }),
    'User-Agent': z.string().openapi({ example: 'ModESP-Cloud-Webhooks/1' }),
  });
  const hook = (event, summary, data, example) => registry.registerWebhook({
    method: 'post', path: event, tags: ['Webhooks'], summary,
    description: 'Answer `2xx` within 10 s. Anything else is retried after 1 min, 5 min, 30 min, 2 h and 12 h, then the delivery is `dead`.',
    request: { headers: HEADERS, body: { content: { 'application/json': { schema: envelope(event, data, example) } } } },
    responses: { 200: { description: 'Delivered' } },
  });

  const alarmData = z.object({ ...base, alarm_id: z.number().int(), alarm_code: z.string(), severity: z.enum(['critical', 'warning', 'info']).nullable(), active: z.boolean() });
  const alarmEx = { device_id: 'E00118', device_uuid: 'af9b98f9-1aa5-414b-9dbc-095affa5dd7f', device_name: 'Freezer cabinet 3', site_id: '4f897f69-9f24-4072-bc0e-b727170e7dc0', site_name: 'Store №212', alarm_id: 173, alarm_code: 'high_temp_alarm', severity: 'critical', active: true };
  hook('alarm.raised', 'An alarm became active', alarmData, alarmEx);
  hook('alarm.cleared', 'An alarm returned to normal', alarmData, { ...alarmEx, active: false });
  hook('alarm.acknowledged', 'Someone acknowledged an alarm',
    z.object({ ...base, alarm_id: z.number().int(), alarm_code: z.string(), acknowledged_by: z.string().nullable().openapi({ description: 'E-mail of the person, or `apikey:<name>`' }), note: z.string().nullable() }),
    { ...alarmEx, severity: undefined, active: undefined, acknowledged_by: 'tech@example.com', note: 'Door left open, closed it' });
  const presence = z.object({ ...base, online: z.boolean(), last_seen: isoDate.nullable() });
  hook('device.offline', 'A controller stopped reporting', presence, { ...alarmEx, alarm_id: undefined, alarm_code: undefined, severity: undefined, active: undefined, online: false, last_seen: '2026-09-08T20:50:00.000Z' });
  hook('device.online', 'A controller is back', presence, { ...alarmEx, alarm_id: undefined, alarm_code: undefined, severity: undefined, active: undefined, online: true, last_seen: '2026-09-08T20:53:00.000Z' });
  const wo = z.object({ ...base, work_order_id: z.string(), action: z.enum(['created', 'updated', 'assigned', 'started', 'closed', 'cancelled']), status: z.string(), assigned_to: uuid.nullable() });
  const woEx = { device_id: 'E00118', device_uuid: 'af9b98f9-1aa5-414b-9dbc-095affa5dd7f', device_name: 'Freezer cabinet 3', site_id: '4f897f69-9f24-4072-bc0e-b727170e7dc0', site_name: 'Store №212', work_order_id: '2', status: 'new', assigned_to: null };
  for (const a of ['created', 'updated', 'assigned', 'started', 'closed', 'cancelled']) hook(`work_order.${a}`, `A work order was ${a}`, wo, { ...woEx, action: a });
  hook('hint.opened', 'A maintenance hint opened',
    z.object({ ...base, hint_id: z.number().int(), rule_key: z.string(), alarm_code: z.string().nullable(), severity: z.string().nullable(), value: z.number().nullable(), threshold: z.number().nullable(), window_hours: z.number().nullable() }),
    { ...woEx, work_order_id: undefined, status: undefined, assigned_to: undefined, hint_id: 12, rule_key: 'compressor_runtime', alarm_code: null, severity: 'warning', value: 0.93, threshold: 0.85, window_hours: 24 });
  const rolloutData = z.object({
    rollout_id: uuid, firmware_version: z.string().nullable(), total: z.number().int(), succeeded: z.number().int(), failed: z.number().int(),
    fail_pct: z.number().int(), fail_threshold_pct: z.number().int().nullable(), paused_reason: z.enum(['manual', 'failures']).nullable(),
  });
  const rolloutEx = { rollout_id: '9c1a0d2e-3b4f-4a5b-8c6d-7e8f9a0b1c2d', firmware_version: '1.4.2', total: 40, succeeded: 38, failed: 2, fail_pct: 5, fail_threshold_pct: 50, paused_reason: null };
  hook('ota.rollout_completed', 'A firmware rollout finished', rolloutData, rolloutEx);
  hook('ota.rollout_paused', 'A firmware rollout paused itself after too many failures', rolloutData, { ...rolloutEx, succeeded: 4, failed: 6, fail_pct: 60, paused_reason: 'failures' });
  hook('ping', 'The test event from the Integrations page', z.object({}), {});
};
