'use strict';

/** Sites: the places devices live. */

module.exports = function register({ z, registry, uuid, isoDate, mqttId, dataOf, listOf, errorOf, withCommon }) {
  const address = {
    country_code: z.string().length(2).nullable().optional().openapi({ example: 'UA' }),
    country: z.string().max(64).nullable().optional(),
    region: z.string().max(128).nullable().optional().openapi({ example: 'Lviv oblast' }),
    city: z.string().max(128).nullable().optional().openapi({ example: 'Lviv' }),
    address_line: z.string().max(256).nullable().optional(),
    postal_code: z.string().max(16).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    timezone: z.string().max(64).nullable().optional().openapi({ example: 'Europe/Kyiv' }),
    notes: z.string().max(4000).nullable().optional(),
  };
  const Site = registry.register('Site', z.object({
    id: uuid, tenant_id: uuid,
    name: z.string().openapi({ example: 'Store №212' }),
    country_code: z.string().nullable(), country: z.string().nullable(), region: z.string().nullable(), city: z.string().nullable(),
    address_line: z.string().nullable(), postal_code: z.string().nullable(),
    latitude: z.number().nullable(), longitude: z.number().nullable(),
    geo_source: z.string().nullable(), geo_precision: z.string().nullable(), geocoded_at: isoDate.nullable(),
    geo_attempts: z.number().int(), geo_last_attempt_at: isoDate.nullable(), geo_error: z.string().nullable(),
    osm_type: z.string().nullable(), osm_id: z.string().nullable(),
    timezone: z.string().nullable(), notes: z.string().nullable(),
    created_at: isoDate, updated_at: isoDate,
    device_count: z.number().int(), online_count: z.number().int(), alarm_count: z.number().int(),
  }));
  const SiteDetail = registry.register('SiteDetail', Site.extend({
    devices: z.array(z.object({ id: uuid, mqtt_device_id: mqttId, name: z.string().nullable(), location: z.string().nullable(), status: z.string(), online: z.boolean(), latitude: z.number().nullable(), longitude: z.number().nullable(), alarm_active: z.boolean(), air_temp: z.number().nullable() })),
  }));
  const geocoderMeta = z.object({ geocoder: z.any().openapi({ description: '`manual`, `skipped` or the geocoder outcome' }) });
  const siteParam = z.object({ id: uuid });

  registry.registerPath({
    method: 'get', path: '/sites', tags: ['Sites'], summary: 'List sites', description: 'A person sees the sites where they see a device or hold a site grant; an API key sees them all.',
    request: { query: z.object({
      search: z.string().max(128).optional().openapi({ description: 'Name, city, region or address' }),
      country_code: z.string().length(2).optional(), region: z.string().optional(), city: z.string().optional(),
    }) },
    responses: withCommon({ 200: listOf(Site, 'Sites by name') }),
  });
  registry.registerPath({
    method: 'get', path: '/sites/{id}', tags: ['Sites'], summary: 'One site with its devices',
    request: { params: siteParam },
    responses: withCommon({ 200: dataOf(SiteDetail, 'The site'), 404: errorOf('`not_found`') }),
  });
  registry.registerPath({
    method: 'post', path: '/sites', tags: ['Sites'], summary: 'Create a site', description: 'Scope `admin`. Without coordinates the address is geocoded in the background. Counted against the plan\'s `max_sites`.',
    request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(256).openapi({ example: 'Store №212' }), ...address }) } } } },
    responses: withCommon({
      201: { description: 'Created', content: { 'application/json': { schema: z.object({ data: Site, meta: geocoderMeta }) } } },
      400: errorOf('`validation_failed`'), 402: errorOf('`plan_limit` (`resource: sites`)'), 409: errorOf('`conflict`: a site with this name exists'),
    }),
  });
  registry.registerPath({
    method: 'patch', path: '/sites/{id}', tags: ['Sites'], summary: 'Change a site', description: 'Scope `admin`. Changing the address re-geocodes unless coordinates are given.',
    request: { params: siteParam, body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(256).optional(), ...address }) } } } },
    responses: withCommon({
      200: { description: 'Updated', content: { 'application/json': { schema: z.object({ data: Site.omit({ device_count: true, online_count: true, alarm_count: true }), meta: geocoderMeta }) } } },
      400: errorOf('`validation_failed`'), 404: errorOf('`not_found`'), 409: errorOf('`conflict`'),
    }),
  });
  registry.registerPath({
    method: 'get', path: '/sites/{id}/export.pdf', tags: ['Reports'], summary: 'HACCP report for a whole site (PDF)', description: 'Plan feature `reports`. Every active device of the site (up to 50) in one document. 10 exports per minute.',
    request: { params: siteParam, query: z.object({
      from: isoDate.optional(), to: isoDate.optional(), hours: z.number().int().optional(),
      bucket: z.enum(['5m', '15m', '1h', '6h', '1d']).optional(), channels: z.string().optional(), lang: z.enum(['uk', 'en', 'pl', 'de']).optional(),
    }) },
    responses: withCommon({
      200: { description: 'The report', headers: { 'X-Report-Code': { schema: { type: 'string' } }, 'X-Report-Sha256': { schema: { type: 'string' } } }, content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } },
      400: errorOf('`validation_failed` or `too_much_data`'), 402: errorOf('`plan_feature`'), 404: errorOf('`not_found` or `no_data`'), 429: errorOf('`rate_limited`'),
    }),
  });
};
