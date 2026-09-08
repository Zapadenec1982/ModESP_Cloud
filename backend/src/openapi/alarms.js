'use strict';

/** Alarms: list, statistics, acknowledgement, per-device history, CSV. */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const severity = z.enum(['critical', 'warning', 'info']);
  const alarmId = z.string().regex(/^\d{1,18}$/).openapi({ example: '173', description: 'Numeric alarm id' });
  const Alarm = registry.register('Alarm', z.object({
    id: z.string().openapi({ example: '173' }),
    device_id: mqttId,
    device_name: z.string().nullable(),
    mqtt_device_id: mqttId,
    alarm_code: z.string().openapi({ example: 'high_temp_alarm' }),
    severity,
    active: z.boolean(),
    value: z.number().nullable().openapi({ example: -9.5 }),
    limit_value: z.number().nullable().openapi({ example: -15 }),
    triggered_at: isoDate,
    cleared_at: isoDate.nullable(),
    acknowledged_at: isoDate.nullable(),
    acknowledged_by_email: z.string().nullable().openapi({ description: 'A person\'s e-mail or `apikey:<name>`' }),
    ack_note: z.string().nullable(),
    escalated_at: isoDate.nullable().openapi({ description: 'When the unacknowledged alarm was escalated to the organisation admins' }),
    work_order_id: z.string().nullable(),
    work_order_status: z.string().nullable(),
  }));
  const paging = {
    limit: z.number().int().min(1).max(200).optional().openapi({ description: 'Default 50' }),
    offset: z.number().int().min(0).optional(),
  };

  registry.registerPath({
    method: 'get', path: '/alarms', tags: ['Alarms'], summary: 'List alarms', description: 'Newest first over the devices the caller sees.',
    request: { query: z.object({
      active: z.enum(['true', 'false']).optional(),
      severity: z.string().optional().openapi({ description: 'Comma-separated: `critical,warning,info`', example: 'critical,warning' }),
      from: isoDate.optional().openapi({ description: 'On `triggered_at`' }), to: isoDate.optional(),
      ...paging,
    }) },
    responses: withCommon({ 200: listOf(Alarm, 'Alarms') }),
  });
  registry.registerPath({
    method: 'get', path: '/alarms/stats', tags: ['Alarms'], summary: 'Alarm counts and mean duration per code',
    request: { query: z.object({ from: isoDate.optional().openapi({ description: 'Default 30 days ago' }), to: isoDate.optional() }) },
    responses: withCommon({ 200: listOf(z.object({ alarm_code: z.string(), count: z.number().int(), avg_duration_sec: z.number().int().nullable() }), 'Most frequent first') }),
  });
  registry.registerPath({
    method: 'post', path: '/alarms/{id}/ack', tags: ['Alarms'], summary: 'Acknowledge an alarm', description: 'Scope `write` or `admin`. Stops the escalation; fires the `alarm.acknowledged` webhook.',
    request: { params: z.object({ id: alarmId }), body: { content: { 'application/json': { schema: z.object({ note: z.string().max(512).optional().nullable().openapi({ example: 'CMMS ticket #4471' }) }) } } } },
    responses: withCommon({
      200: dataOf(Alarm.pick({ id: true, device_id: true, alarm_code: true, severity: true, active: true, triggered_at: true, acknowledged_at: true, ack_note: true, acknowledged_by_email: true }), 'Acknowledged'),
      400: errorOf('`validation_failed`'), 404: errorOf('`not_found`'), 409: errorOf('`already_acknowledged`'),
    }),
  });
  registry.registerPath({
    method: 'get', path: '/alarms/{id}/deliveries', tags: ['Alarms'], summary: 'Who was notified about an alarm', description: 'Scope `admin`.',
    request: { params: z.object({ id: alarmId }) },
    responses: withCommon({ 200: listOf(z.object({
      id: z.string(), channel: z.enum(['telegram', 'email', 'push', 'webhook']).or(z.string()), status: z.string(), error_message: z.string().nullable(), created_at: isoDate,
      user_email: z.string().nullable(), subscriber_label: z.string().nullable(), subscriber_address: z.string().nullable(),
    }), 'Notification log, oldest first'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/alarms', tags: ['Alarms'], summary: 'Alarm history of one device',
    request: { params: z.object({ id: z.string().openapi({ description: 'Device UUID or controller id' }) }), query: z.object({ active: z.enum(['true', 'false']).optional(), from: isoDate.optional(), to: isoDate.optional(), ...paging }) },
    responses: withCommon({ 200: listOf(Alarm.omit({ device_id: true, device_name: true, mqtt_device_id: true, acknowledged_by_email: true }).extend({ acknowledged_by: uuid.nullable() }), 'Newest first'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'get', path: '/alarms/export.csv', tags: ['Alarms'], summary: 'Alarms as CSV', description: 'Up to 90 days and 50 000 rows. 10 exports per minute.',
    request: { query: z.object({ from: isoDate.optional(), to: isoDate.optional(), hours: z.number().int().optional(), active: z.enum(['true']).optional(), severity: z.string().optional() }) },
    responses: withCommon({ 200: { description: '`Device, Device Name, Alarm Code, Severity, Active, Value, Limit, Started, Cleared`', content: { 'text/csv': { schema: z.string() } } }, 429: errorOf('`rate_limited`') }),
  });
};
