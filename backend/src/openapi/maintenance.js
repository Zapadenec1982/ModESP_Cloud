'use strict';

/** Maintenance hints (repair-prevention rules). */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const Hint = registry.register('MaintenanceHint', z.object({
    id: z.string().openapi({ example: '12' }),
    device_id: mqttId, device_uuid: uuid.optional(), device_name: z.string().nullable().optional(), device_model: z.string().nullable().optional(),
    rule_key: z.string().openapi({ example: 'alarm_repeat' }),
    alarm_code: z.string().nullable(),
    severity: z.enum(['info', 'warning']),
    value: z.number().nullable().openapi({ description: 'What was measured', example: 6 }),
    threshold: z.number().nullable().openapi({ example: 5 }),
    window_hours: z.number().int().nullable().openapi({ example: 168 }),
    opened_at: isoDate, last_seen_at: isoDate.nullable(), closed_at: isoDate.nullable(), closed_reason: z.string().nullable(),
    acknowledged_at: isoDate.nullable(), ack_note: z.string().nullable(), acknowledged_by_email: z.string().nullable(),
    work_order_id: z.string().nullable(), work_order_status: z.string().nullable(),
  }));
  const hintId = z.object({ id: z.string().regex(/^\d{1,18}$/).openapi({ example: '12' }) });
  const note = z.object({ note: z.string().max(512).optional().nullable() });
  const feature = errorOf('`plan_feature`: the plan has no `maintenance` feature');

  registry.registerPath({
    method: 'get', path: '/maintenance/hints', tags: ['Maintenance'], summary: 'List hints', description: 'Plan feature `maintenance`. Open hints first.',
    request: { query: z.object({
      active: z.enum(['true', 'false', 'all']).optional().openapi({ description: '`true` (default) = open only, `false` = closed only, anything else = all' }),
      limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(),
    }) },
    responses: withCommon({ 200: listOf(Hint, 'Hints'), 402: feature }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/hints', tags: ['Maintenance'], summary: 'Hints of one device',
    request: { params: z.object({ id: z.string().openapi({ description: 'Device UUID or controller id' }) }), query: z.object({ limit: z.number().int().min(1).max(200).optional() }) },
    responses: withCommon({ 200: { description: 'Hints, open first', content: { 'application/json': { schema: z.object({ data: z.array(Hint), feature_enabled: z.boolean() }) } } }, 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'post', path: '/maintenance/hints/{id}/ack', tags: ['Maintenance'], summary: 'Acknowledge a hint', description: 'Scope `write` or `admin`. Plan feature `maintenance`.',
    request: { params: hintId, body: { content: { 'application/json': { schema: note } } } },
    responses: withCommon({ 200: dataOf(Hint.pick({ id: true, device_id: true, rule_key: true, alarm_code: true, severity: true, acknowledged_at: true, ack_note: true, acknowledged_by_email: true }), 'Acknowledged'), 400: errorOf('`validation_failed`'), 402: feature, 404: errorOf('`not_found`'), 409: errorOf('`closed` or `already_acknowledged`') }),
  });
  registry.registerPath({
    method: 'post', path: '/maintenance/hints/{id}/dismiss', tags: ['Maintenance'], summary: 'Dismiss a hint', description: 'Scope `admin`. Plan feature `maintenance`. Closes the hint with reason `dismissed`.',
    request: { params: hintId, body: { content: { 'application/json': { schema: note } } } },
    responses: withCommon({ 200: dataOf(Hint.pick({ id: true, device_id: true, rule_key: true, alarm_code: true, severity: true, closed_at: true, closed_reason: true }), 'Dismissed'), 400: errorOf('`validation_failed`'), 402: feature, 404: errorOf('`not_found`'), 409: errorOf('`closed`') }),
  });
};
