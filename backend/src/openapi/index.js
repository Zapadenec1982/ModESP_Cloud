'use strict';

/**
 * OpenAPI 3.1 description of the integration surface (plan epic 2.6): what
 * an external system reaches with an API key. Built from zod schemas with
 * @asteasolutions/zod-to-openapi and served by routes/docs.js as JSON plus a
 * self-hosted Swagger UI. `docs/openapi.json` is exported from the same
 * document (scripts/openapi-export.js) and CI fails when it drifts.
 *
 * Only endpoints an API key may call are described here; the account and
 * organisation surface (auth, users, tenants, billing…) stays in
 * docs/API_REFERENCE.md.
 */

const { z } = require('zod');
const { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } = require('@asteasolutions/zod-to-openapi');
const pkg = require('../../package.json');

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── Security ──────────────────────────────────────────────
registry.registerComponent('securitySchemes', 'apiKey', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'modesp_<key>',
  description:
    'An organisation API key created on the Integrations page (`modesp_` + 43 characters). ' +
    'Its scope maps onto a role: `read` → viewer, `write` → technician, `admin` → admin. ' +
    'A key sees every device of its organisation and never reaches the account surface ' +
    '(users, keys, organisations, billing, profile, sessions → `403 api_key_scope`).',
});
registry.registerComponent('securitySchemes', 'userToken', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'The short-lived access token of a signed-in person (`POST /api/auth/login`). Every endpoint below accepts it as well.',
});

// ── Shared schemas ────────────────────────────────────────
const uuid = z.string().uuid().openapi({ example: 'af9b98f9-1aa5-414b-9dbc-095affa5dd7f' });
const isoDate = z.string().datetime({ offset: true }).openapi({ example: '2026-09-08T20:53:29.427Z' });
const mqttId = z.string().openapi({ example: 'E00118', description: 'Controller id as printed on the device and used on the broker' });

const ErrorSchema = registry.register('Error', z.object({
  error:   z.string().openapi({ example: 'not_found', description: 'Machine-readable code' }),
  message: z.string().openapi({ example: 'Device not found' }),
  status:  z.number().int().openapi({ example: 404 }),
}).passthrough().openapi({ description: 'Every non-2xx answer carries this envelope; some codes add fields (e.g. `402 plan_feature` adds `feature`).' }));

const PaginationMeta = registry.register('PaginationMeta', z.object({
  total:  z.number().int().openapi({ example: 128 }),
  limit:  z.number().int().openapi({ example: 50 }),
  offset: z.number().int().openapi({ example: 0 }),
}));

/** { data: T } */
const dataOf = (schema, description) => ({ description, content: { 'application/json': { schema: z.object({ data: schema }) } } });
/** { data: T[], meta? } */
const listOf = (schema, description, meta) => ({
  description,
  content: { 'application/json': { schema: z.object(meta ? { data: z.array(schema), meta } : { data: z.array(schema) }) } },
});
const errorOf = (description) => ({ description, content: { 'application/json': { schema: ErrorSchema } } });

const COMMON_ERRORS = {
  401: errorOf('Missing, invalid, revoked or expired credentials'),
  403: errorOf('The role behind the credentials may not do this, or the endpoint is closed to API keys (`api_key_scope`)'),
};
const withCommon = (responses) => ({ ...COMMON_ERRORS, ...responses });

const common = { z, registry, uuid, isoDate, mqttId, ErrorSchema, PaginationMeta, dataOf, listOf, errorOf, withCommon };

// ── Paths, grouped by tag ─────────────────────────────────
require('./devices')(common);
require('./alarms')(common);
require('./sites')(common);
require('./work-orders')(common);
require('./maintenance')(common);
require('./reports')(common);
require('./integrations')(common);

const TAGS = [
  { name: 'Devices', description: 'Controllers of the organisation: state, metadata, commands, service history' },
  { name: 'Telemetry', description: 'Raw and bucketed measurements, events, energy' },
  { name: 'Alarms', description: 'Active and historical alarms, acknowledgement' },
  { name: 'Sites', description: 'Stores, warehouses, kitchens — the places devices live' },
  { name: 'Work orders', description: 'Service tasks from alarm to closed record' },
  { name: 'Maintenance', description: 'Repair-prevention hints derived from telemetry' },
  { name: 'Reports', description: 'HACCP, alarm and energy reports: archive and exports' },
  { name: 'API keys', description: 'Machine credentials of the organisation (admin, user token only)' },
  { name: 'Webhooks', description: 'Signed HTTP callbacks on organisation events (admin, user token only)' },
];

let cached = null;

/** The full OpenAPI document (built once per process). */
function document() {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV31(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ModESP Cloud API',
      version: pkg.version,
      description:
        'Integration surface of ModESP Cloud — the endpoints a CMMS, BI or ERP calls with an organisation API key.\n\n' +
        '**Authentication.** `Authorization: Bearer modesp_…` (API key) or a person\'s access token. ' +
        'A key represents the whole organisation; its scope decides what it may change.\n\n' +
        '**Errors.** Every non-2xx answer is `{ error, message, status }`. `402 plan_feature` means the organisation\'s plan lacks the feature; ' +
        '`423 organisation_closed` means the organisation is closed and read-only; `429 too_many_requests` is rate limiting.\n\n' +
        '**Webhooks.** Outbound events are described under *Webhooks* at the bottom: a POST per subscribed event, signed with ' +
        '`X-ModESP-Signature: v1=HMAC-SHA256(secret, "<X-ModESP-Timestamp>.<body>")`.',
    },
    servers: [{ url: '/api', description: 'This installation' }],
    security: [{ apiKey: [] }, { userToken: [] }],
    tags: TAGS,
  });
  return cached;
}

module.exports = { document, registry };
