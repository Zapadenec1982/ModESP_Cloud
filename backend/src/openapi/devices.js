'use strict';

/** Devices, telemetry, events, commands, service records, fleet summary. */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const deviceParam = z.object({ id: z.string().openapi({ description: 'Device UUID or controller id (`mqtt_device_id`)', example: 'E00118' }) });
  const deviceErrors = { 403: errorOf('`forbidden`: the caller may not see this device, or the role may not do this'), 404: errorOf('`not_found`') };

  const SiteColumns = {
    site_id: uuid.nullable(), site_name: z.string().nullable(), site_city: z.string().nullable(), site_region: z.string().nullable(),
    site_country: z.string().nullable(), site_latitude: z.number().nullable(), site_longitude: z.number().nullable(),
  };
  const DeviceListItem = registry.register('Device', z.object({
    id: uuid,
    mqtt_device_id: mqttId,
    name: z.string().nullable().openapi({ example: 'Freezer cabinet 3' }),
    location: z.string().nullable().openapi({ example: 'Sales floor, left wall' }),
    serial_number: z.string().nullable(),
    model: z.string().nullable().openapi({ example: 'ModESP-R1' }),
    comment: z.string().nullable(),
    manufactured_at: z.string().nullable().openapi({ example: '2025-03-01' }),
    firmware_version: z.string().nullable().openapi({ example: '1.4.2' }),
    online: z.boolean(),
    status: z.enum(['active', 'pending', 'deleted']),
    last_seen: isoDate.nullable(),
    created_at: isoDate,
    latitude: z.number().nullable(), longitude: z.number().nullable(),
    ...SiteColumns,
    hints_open: z.number().int().openapi({ description: 'Open maintenance hints' }),
    alarm_active: z.boolean(),
    air_temp: z.number().nullable().openapi({ description: 'Last air temperature, °C', example: -18.4 }),
    door_open: z.boolean().nullable(),
  }));
  const DeviceDetail = registry.register('DeviceDetail', DeviceListItem.omit({ hints_open: true, alarm_active: true, air_temp: true, door_open: true }).extend({
    proto_version: z.number().int().nullable(),
    last_state: z.record(z.any()).nullable().openapi({ description: 'Latest reported state keyed by parameter (`thermostat.setpoint`, `sensors.air` …); see `GET /meta` for the key registry' }),
    tenant_id: uuid, tenant_slug: z.string(),
    mqtt_username: z.string().nullable(), has_mqtt_credentials: z.boolean(),
    model_id: uuid.nullable(), model_name: z.string().nullable(),
    compressor_kw: z.number().nullable(), evap_fan_kw: z.number().nullable(), cond_fan_kw: z.number().nullable(), defrost_heater_kw: z.number().nullable(), standby_kw: z.number().nullable(),
    users: z.array(z.object({ id: uuid, email: z.string(), role: z.string() })).openapi({ description: 'People with an explicit grant on this device' }),
  }));
  const powerField = z.number().min(0).max(100).nullable().optional().openapi({ description: 'kW, overrides the model' });
  const DevicePatch = z.object({
    name: z.string().max(128).optional(),
    location: z.string().max(256).optional(),
    serial_number: z.string().max(64).optional(),
    model: z.string().max(64).optional(),
    comment: z.string().max(2000).optional(),
    manufactured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().openapi({ example: '2025-03-01' }),
    model_id: uuid.nullable().optional(),
    compressor_kw: powerField, evap_fan_kw: powerField, cond_fan_kw: powerField, defrost_heater_kw: powerField, standby_kw: powerField,
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    site_id: uuid.nullable().optional().openapi({ description: 'Admin only' }),
  });

  registry.registerPath({
    method: 'get', path: '/devices', tags: ['Devices'], summary: 'List devices',
    description: 'Every non-deleted device of the organisation with its site and live state. A person with a technician or viewer role sees only the devices granted to them; an API key sees them all.',
    responses: withCommon({ 200: listOf(DeviceListItem, 'Devices ordered by name') }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}', tags: ['Devices'], summary: 'One device with its latest state',
    request: { params: deviceParam },
    responses: withCommon({ 200: dataOf(DeviceDetail, 'The device'), ...deviceErrors }),
  });
  registry.registerPath({
    method: 'patch', path: '/devices/{id}', tags: ['Devices'], summary: 'Change device metadata', description: 'Scope `write` or `admin`. Moving a device to another site (`site_id`) needs `admin`.',
    request: { params: deviceParam, body: { content: { 'application/json': { schema: DevicePatch } } } },
    responses: withCommon({
      200: dataOf(DeviceListItem.pick({ id: true, mqtt_device_id: true, name: true, location: true, serial_number: true, model: true, comment: true, manufactured_at: true, firmware_version: true, status: true, created_at: true, latitude: true, longitude: true, site_id: true }), 'The updated fields'),
      400: errorOf('`validation_failed` or `invalid_site`'), ...deviceErrors,
    }),
  });
  registry.registerPath({
    method: 'post', path: '/devices/{id}/command', tags: ['Devices'], summary: 'Send a parameter to the controller',
    description: 'Scope `write` or `admin`. `key` must be writable per `GET /meta`; `value` is checked against its type, range and step. Setpoints, limits, resets and manual defrost need `confirm: true`.',
    request: { params: deviceParam, body: { content: { 'application/json': { schema: z.object({
      key: z.string().openapi({ example: 'thermostat.setpoint' }),
      value: z.union([z.number(), z.boolean(), z.string()]).openapi({ example: -18 }),
      confirm: z.boolean().optional().openapi({ description: 'Required for dangerous keys' }),
    }) } } } },
    responses: withCommon({
      200: dataOf(z.object({ device_id: z.string(), key: z.string(), value: z.any(), sent: z.literal(true) }), 'Published to the broker'),
      400: errorOf('`validation_failed` (unknown key, wrong type/range/step) or `confirmation_required`'),
      ...deviceErrors, 503: errorOf('`mqtt_unavailable`'),
    }),
  });
  registry.registerPath({
    method: 'post', path: '/devices/{id}/request-state', tags: ['Devices'], summary: 'Ask the controller to report its full state now',
    request: { params: deviceParam },
    responses: withCommon({ 200: dataOf(z.object({ device_id: z.string(), requested: z.literal(true) }), 'Request published'), ...deviceErrors, 503: errorOf('`mqtt_unavailable`') }),
  });

  // ── Service records ──
  const ServiceRecord = registry.register('ServiceRecord', z.object({
    id: uuid, service_date: z.string().openapi({ example: '2026-09-01' }), technician: z.string(), reason: z.string(), work_done: z.string(), created_at: isoDate,
  }));
  registry.registerPath({
    method: 'get', path: '/devices/{id}/service-records', tags: ['Devices'], summary: 'Service history of a device',
    request: { params: deviceParam },
    responses: withCommon({ 200: listOf(ServiceRecord, 'Newest first'), ...deviceErrors }),
  });
  registry.registerPath({
    method: 'post', path: '/devices/{id}/service-records', tags: ['Devices'], summary: 'Add a service record', description: 'Scope `write` or `admin`. Closing a work order creates one automatically.',
    request: { params: deviceParam, body: { content: { 'application/json': { schema: z.object({
      service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2026-09-01' }),
      technician: z.string().min(1).max(128), reason: z.string().min(1).max(2000), work_done: z.string().min(1).max(2000),
    }) } } } },
    responses: withCommon({ 201: dataOf(ServiceRecord, 'Created'), 400: errorOf('`validation_failed`'), ...deviceErrors }),
  });
  registry.registerPath({
    method: 'delete', path: '/devices/{id}/service-records/{recordId}', tags: ['Devices'], summary: 'Delete a service record', description: 'Scope `write` or `admin`.',
    request: { params: deviceParam.extend({ recordId: uuid }) },
    responses: withCommon({ 200: dataOf(z.object({ deleted: z.literal(true) }), 'Deleted'), ...deviceErrors }),
  });

  // ── Telemetry ──
  const rangeQuery = {
    from: isoDate.optional().openapi({ description: 'Start (ISO 8601); use together with `to`' }),
    to: isoDate.optional(),
    hours: z.number().int().min(1).optional().openapi({ description: 'Alternative to from/to: the last N hours (default 24)' }),
  };
  const channelsQuery = z.string().optional().openapi({ description: 'Comma-separated channels, e.g. `air,evap,setpoint`; all when omitted', example: 'air,evap' });
  const bucketEnum = z.enum(['5m', '15m', '1h', '6h', '1d']);
  const csvResponse = (description) => ({ description, content: { 'text/csv': { schema: z.string().openapi({ description: 'UTF-8 with BOM' }) } } });
  const pdfResponse = (description) => ({ description, headers: {
    'X-Report-Code': { schema: { type: 'string' }, description: 'Verification code printed on the report; also `GET /public/report/{code}`' },
    'X-Report-Sha256': { schema: { type: 'string' } },
  }, content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } });

  registry.registerPath({
    method: 'get', path: '/devices/{id}/telemetry', tags: ['Telemetry'], summary: 'Raw samples',
    description: 'Up to 31 days per call and 10 000 rows; a longer answer is cut and marked with the `X-Truncated: true` header. Retention depends on the plan; older data is available hourly through `telemetry/stats` and the reports.',
    request: { params: deviceParam, query: z.object({ ...rangeQuery, channels: channelsQuery }) },
    responses: withCommon({
      200: listOf(z.object({ time: isoDate, channel: z.string().openapi({ example: 'air' }), value: z.number() }), 'Samples in time order'),
      400: errorOf('`validation_failed`: bad dates'), ...deviceErrors,
    }),
  });
  const Bucket = z.object({ time: isoDate }).catchall(z.object({ min: z.number(), max: z.number(), avg: z.number(), samples: z.number().int() }));
  registry.registerPath({
    method: 'get', path: '/devices/{id}/telemetry/stats', tags: ['Telemetry'], summary: 'Bucketed min/max/avg',
    request: { params: deviceParam, query: z.object({ ...rangeQuery, channels: channelsQuery, bucket: bucketEnum.optional().openapi({ description: 'Default `1h`' }) }) },
    responses: withCommon({
      200: dataOf(z.object({
        buckets: z.array(Bucket).openapi({ description: 'One object per bucket, channels as keys' }),
        summary: z.record(z.object({ min: z.number(), max: z.number(), avg: z.number() })).openapi({ description: 'Per channel over the whole range' }),
      }), 'Aggregates'),
      400: errorOf('`validation_failed`: bad dates or bucket'), ...deviceErrors,
    }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/energy/summary', tags: ['Telemetry'], summary: 'Energy estimate for a period', description: 'Plan feature `energy`. kWh from compressor and fan run time and the device or model power ratings; cost from the organisation tariff.',
    request: { params: deviceParam, query: z.object(rangeQuery) },
    responses: withCommon({
      200: dataOf(z.object({
        total_kwh: z.number(), estimated_cost: z.number().nullable(), currency: z.string().nullable(), daily_avg_kwh: z.number(),
        breakdown: z.record(z.object({ kwh: z.number(), pct: z.number() })).nullable(),
        source: z.string(), samples: z.number().int(), period: z.object({ from: isoDate, to: isoDate }),
      }), 'The estimate'),
      400: errorOf('`validation_failed`'), 402: errorOf('`plan_feature`'), ...deviceErrors,
    }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/events', tags: ['Telemetry'], summary: 'Device events', description: 'Compressor and defrost cycles, door openings, restarts, parameter changes.',
    request: { params: deviceParam, query: z.object({
      event_type: z.string().optional().openapi({ example: 'defrost_start' }),
      from: isoDate.optional(), to: isoDate.optional(),
      limit: z.number().int().min(1).max(200).optional().openapi({ description: 'Default 50' }),
      offset: z.number().int().min(0).optional(),
    }) },
    responses: withCommon({ 200: listOf(z.object({ id: z.string(), event_type: z.string(), payload: z.record(z.any()).nullable(), time: isoDate }), 'Newest first'), ...deviceErrors }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/telemetry/export.csv', tags: ['Telemetry'], summary: 'Raw samples as CSV', description: 'Same range rules as `telemetry`, up to 500 000 rows. 10 exports per minute.',
    request: { params: deviceParam, query: z.object({ ...rangeQuery, channels: channelsQuery }) },
    responses: withCommon({ 200: csvResponse('`Timestamp, Channel, Value`'), 400: errorOf('`validation_failed`'), ...deviceErrors, 429: errorOf('`rate_limited`') }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/telemetry/export.pdf', tags: ['Reports'], summary: 'HACCP report for one device (PDF)', description: 'Plan feature `reports`. Up to 366 days; registered with a verification code. 10 exports per minute.',
    request: { params: deviceParam, query: z.object({ ...rangeQuery, bucket: bucketEnum.optional(), channels: channelsQuery, lang: z.enum(['uk', 'en', 'pl', 'de']).optional() }) },
    responses: withCommon({ 200: pdfResponse('The report'), 400: errorOf('`validation_failed` or `too_much_data`'), 402: errorOf('`plan_feature`'), ...deviceErrors, 429: errorOf('`rate_limited`') }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/export/inventory.csv', tags: ['Devices'], summary: 'Device inventory as CSV',
    responses: withCommon({ 200: csvResponse('`Device ID, Name, Location, Serial, Model, Firmware, Online, Last Seen`'), 429: errorOf('`rate_limited`') }),
  });

  registry.registerPath({
    method: 'get', path: '/fleet/summary', tags: ['Devices'], summary: 'Fleet counters',
    responses: withCommon({ 200: dataOf(z.object({ devices_total: z.number().int(), devices_online: z.number().int(), devices_active: z.number().int(), alarms_active: z.number().int(), alarms_24h: z.number().int() }), 'Counts over the devices the caller sees') }),
  });
};
