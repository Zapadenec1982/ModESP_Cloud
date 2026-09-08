'use strict';

/** Work orders: from alarm or hint to a closed service record. */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const priority = z.enum(['low', 'normal', 'high', 'urgent']);
  const status = z.enum(['new', 'assigned', 'in_progress', 'done', 'cancelled']);
  const orderId = z.string().regex(/^\d{1,18}$/).openapi({ example: '42' });
  const WorkOrder = registry.register('WorkOrder', z.object({
    id: z.string().openapi({ example: '42' }),
    site_id: uuid.nullable(), device_id: uuid.nullable(), device_mqtt_id: mqttId.nullable(),
    alarm_id: z.string().nullable(), hint_id: z.string().nullable(),
    title: z.string().openapi({ example: 'Check door gasket' }), description: z.string().nullable(),
    priority, status,
    assigned_to: uuid.nullable(), assigned_to_email: z.string().nullable(),
    created_by: uuid.nullable(), created_by_email: z.string().nullable(),
    scheduled_at: isoDate.nullable(), assigned_at: isoDate.nullable(), started_at: isoDate.nullable(), closed_at: isoDate.nullable(),
    closed_reason: z.string().nullable(), service_record_id: uuid.nullable(),
    created_at: isoDate, updated_at: isoDate,
    device_name: z.string().nullable(), site_name: z.string().nullable(), site_city: z.string().nullable(), site_address_line: z.string().nullable(),
    site_latitude: z.number().nullable(), site_longitude: z.number().nullable(),
    site_address: z.string().nullable().openapi({ description: 'Formatted address' }), maps_url: z.string().nullable(),
  }));
  const WorkOrderDetail = registry.register('WorkOrderDetail', WorkOrder.extend({
    alarm: z.object({ id: z.string(), alarm_code: z.string(), severity: z.string(), active: z.boolean(), triggered_at: isoDate, cleared_at: isoDate.nullable(), acknowledged_at: isoDate.nullable() }).nullable(),
    hint: z.object({ id: z.string(), rule_key: z.string(), severity: z.string(), value: z.number().nullable(), threshold: z.number().nullable(), opened_at: isoDate, closed_at: isoDate.nullable(), closed_reason: z.string().nullable() }).nullable(),
    service_record: z.object({ id: uuid, service_date: z.string(), technician: z.string(), reason: z.string().nullable(), work_done: z.string(), duration_min: z.number().nullable(), parts: z.any().nullable(), cost: z.number().nullable(), cost_currency: z.string().nullable(), created_at: isoDate }).nullable(),
  }));
  const idParam = z.object({ id: orderId });
  const closed = errorOf('`closed`: the order is done or cancelled');
  const notFound = errorOf('`not_found`');
  const write = 'Scope `write` or `admin`.';

  registry.registerPath({
    method: 'get', path: '/work-orders', tags: ['Work orders'], summary: 'List work orders', description: 'Urgent first, then newest. A technician sees orders assigned to them or on their devices; an API key sees all.',
    request: { query: z.object({
      status: z.enum(['open', 'closed', 'all', 'new', 'assigned', 'in_progress', 'done', 'cancelled']).optional().openapi({ description: '`open` (default) = new, assigned, in_progress; `closed` = done, cancelled' }),
      device_id: uuid.optional(), site_id: uuid.optional(),
      limit: z.number().int().min(1).max(200).optional().openapi({ description: 'Default 50' }), offset: z.number().int().min(0).optional(),
    }) },
    responses: withCommon({ 200: listOf(WorkOrder, 'Orders') }),
  });
  registry.registerPath({
    method: 'get', path: '/work-orders/stats', tags: ['Work orders'], summary: 'Counts and mean reaction times', description: write,
    request: { query: z.object({ from: isoDate.optional().openapi({ description: 'Default 30 days ago' }), to: isoDate.optional() }) },
    responses: withCommon({ 200: { description: 'Counters', content: { 'application/json': { schema: z.object({
      data: z.object({ total: z.number().int(), new: z.number().int(), assigned: z.number().int(), in_progress: z.number().int(), done: z.number().int(), cancelled: z.number().int(), from_alarms: z.number().int(), from_hints: z.number().int(), avg_assign_min: z.number().nullable(), avg_start_min: z.number().nullable(), avg_close_min: z.number().nullable() }),
      meta: z.object({ from: isoDate, to: isoDate }),
    }) } } }, 400: errorOf('`validation_failed`') }),
  });
  registry.registerPath({
    method: 'get', path: '/work-orders/assignees', tags: ['Work orders'], summary: 'People an order can be assigned to', description: 'Scope `admin`.',
    responses: withCommon({ 200: listOf(z.object({ id: uuid, email: z.string(), role: z.enum(['technician', 'admin']), base_address: z.string().nullable() }), 'Active technicians and admins') }),
  });
  registry.registerPath({
    method: 'post', path: '/work-orders', tags: ['Work orders'], summary: 'Create a work order', description: write + ' Give `device_id` or `site_id`. Linking `alarm_id` or `hint_id` acknowledges it. Fires `work_order.created`.',
    request: { body: { content: { 'application/json': { schema: z.object({
      title: z.string().min(1).max(200).openapi({ example: 'Check door gasket' }),
      description: z.string().max(4000).optional().nullable(),
      priority: priority.optional().openapi({ description: 'Default `normal`' }),
      device_id: z.string().min(1).max(64).optional().nullable().openapi({ description: 'Device UUID or controller id', example: 'E00118' }),
      site_id: uuid.optional().nullable(),
      alarm_id: z.number().int().positive().optional().nullable(),
      hint_id: z.number().int().positive().optional().nullable(),
      assigned_to: uuid.optional().nullable(),
      scheduled_at: isoDate.optional().nullable(),
    }) } } } },
    responses: withCommon({ 201: dataOf(WorkOrder, 'Created'), 400: errorOf('`validation_failed`'), 404: errorOf('`not_found`: device') }),
  });
  registry.registerPath({
    method: 'get', path: '/work-orders/{id}', tags: ['Work orders'], summary: 'One work order with its alarm, hint and service record',
    request: { params: idParam },
    responses: withCommon({ 200: dataOf(WorkOrderDetail, 'The order'), 404: notFound }),
  });
  registry.registerPath({
    method: 'patch', path: '/work-orders/{id}', tags: ['Work orders'], summary: 'Change title, description, priority or schedule', description: write,
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({
      title: z.string().min(1).max(200).optional(), description: z.string().max(4000).nullable().optional(), priority: priority.optional(), scheduled_at: isoDate.nullable().optional(),
    }) } } } },
    responses: withCommon({ 200: dataOf(WorkOrder, 'Updated'), 400: errorOf('`validation_failed`'), 404: notFound, 409: closed }),
  });
  registry.registerPath({
    method: 'post', path: '/work-orders/{id}/assign', tags: ['Work orders'], summary: 'Assign to a technician or admin', description: write + ' Fires `work_order.assigned`.',
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ user_id: uuid }) } } } },
    responses: withCommon({ 200: dataOf(WorkOrder, 'Assigned'), 400: errorOf('`validation_failed`'), 404: notFound, 409: errorOf('`closed` or `already_assigned`') }),
  });
  registry.registerPath({
    method: 'post', path: '/work-orders/{id}/start', tags: ['Work orders'], summary: 'Mark work as started', description: write + ' Fires `work_order.started`.',
    request: { params: idParam },
    responses: withCommon({ 200: dataOf(WorkOrder, 'In progress'), 404: notFound, 409: errorOf('`closed` or `already_started`') }),
  });
  registry.registerPath({
    method: 'post', path: '/work-orders/{id}/close', tags: ['Work orders'], summary: 'Close with a service record', description: write + ' Creates the service record on the device. Fires `work_order.closed`.',
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({
      work_done: z.string().min(1).max(2000).openapi({ example: 'Replaced the door gasket, checked the pull-down' }),
      reason: z.string().max(2000).optional().nullable(),
      service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: 'Default today' }),
      duration_min: z.number().int().min(0).max(100000).optional().nullable(),
      parts: z.array(z.object({ name: z.string().min(1).max(120), qty: z.number().min(0).max(100000).optional(), cost: z.number().min(0).optional() })).max(50).optional().nullable(),
      cost: z.number().min(0).max(1e9).optional().nullable(),
      cost_currency: z.string().length(3).optional().nullable().openapi({ example: 'UAH' }),
    }) } } } },
    responses: withCommon({
      200: { description: 'Closed', content: { 'application/json': { schema: z.object({ data: WorkOrder, service_record_id: uuid.nullable() }) } } },
      400: errorOf('`validation_failed`'), 404: notFound, 409: closed,
    }),
  });
  registry.registerPath({
    method: 'post', path: '/work-orders/{id}/cancel', tags: ['Work orders'], summary: 'Cancel an order', description: 'Scope `admin`. Fires `work_order.cancelled`.',
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ reason: z.string().max(512).optional().nullable() }) } } } },
    responses: withCommon({ 200: dataOf(WorkOrder, 'Cancelled'), 400: errorOf('`validation_failed`'), 404: notFound, 409: closed }),
  });
  registry.registerPath({
    method: 'get', path: '/devices/{id}/work-orders', tags: ['Work orders'], summary: 'Work orders of one device',
    request: { params: z.object({ id: z.string().openapi({ description: 'Device UUID or controller id' }) }), query: z.object({ status: z.enum(['all', 'open']).optional().openapi({ description: 'Default `all`' }) }) },
    responses: withCommon({ 200: listOf(WorkOrder, 'Open first, then newest; at most 100'), 404: notFound }),
  });
};
