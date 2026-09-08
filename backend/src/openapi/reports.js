'use strict';

/** The report archive. The HACCP PDF exports live with devices and sites. */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, listOf, errorOf, withCommon, PaginationMeta }) {
  const Report = registry.register('Report', z.object({
    code: z.string().openapi({ example: 'A7K2-M9Q4-X1Z8', description: 'Verification code printed on the PDF' }),
    kind: z.string().nullable(),
    report_type: z.enum(['haccp', 'alarms', 'energy']),
    device_id: mqttId.nullable(), device_name: z.string().nullable(),
    site_id: uuid.nullable(), site_name: z.string().nullable(),
    period_from: isoDate, period_to: isoDate.openapi({ description: 'Exclusive end' }),
    bucket: z.string().nullable(), source: z.string().nullable().openapi({ description: '`raw` or `hourly`' }),
    lang: z.string().nullable(), generated_by: z.string().nullable(), generated_at: isoDate,
    schedule_id: uuid.nullable().openapi({ description: 'Set when produced by a schedule' }),
    file_name: z.string().nullable(), bytes: z.number().nullable(),
    archived: z.boolean().openapi({ description: 'The PDF is still stored and can be downloaded' }),
  }));

  registry.registerPath({
    method: 'get', path: '/reports', tags: ['Reports'], summary: 'Report archive', description: 'Every generated report the caller may see: scheduled and manual, newest first.',
    request: { query: z.object({
      type: z.enum(['haccp', 'alarms', 'energy']).optional(), site_id: uuid.optional(),
      scheduled: z.enum(['true']).optional().openapi({ description: 'Only reports produced by a schedule' }),
      limit: z.number().int().min(1).max(200).optional().openapi({ description: 'Default 50' }), offset: z.number().int().min(0).optional(),
    }) },
    responses: withCommon({ 200: listOf(Report, 'Reports', PaginationMeta) }),
  });
  registry.registerPath({
    method: 'get', path: '/reports/{code}/download', tags: ['Reports'], summary: 'Download an archived PDF',
    request: { params: z.object({ code: z.string().openapi({ example: 'A7K2M9Q4X1Z8', description: 'The code, with or without dashes' }) }) },
    responses: withCommon({
      200: { description: 'The PDF', headers: { 'X-Report-Code': { schema: { type: 'string' } }, 'X-Report-Sha256': { schema: { type: 'string' } } }, content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } },
      404: errorOf('`not_found`: unknown code or no longer archived'),
    }),
  });
};
