/**
 * OpenAPI document and the public docs page (plan epic 2.6).
 * The document must describe routes that exist, be served without
 * credentials, and match the committed docs/openapi.json.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { listRoutes, documentedToExpress } from './helpers/routes.js';

const require = createRequire(import.meta.url);
const { createTestApp } = require('./helpers/app');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openapi = require('../src/openapi');

let app;
beforeAll(() => { app = createTestApp(); });

describe('openapi (plan epic 2.6)', () => {
  it('describes only routes that exist, with the express path parameters', () => {
    const doc = openapi.document();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('ModESP Cloud API');
    expect(doc.servers[0].url).toBe('/api');
    const routes = listRoutes(app);
    const have = new Set(routes.map(r => `${r.method} ${r.path}`));
    const missing = [];
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        const key = `${method.toUpperCase()} ${documentedToExpress(p)}`;
        if (!have.has(key)) missing.push(key);
      }
    }
    expect(missing, 'documented but not mounted').toEqual([]);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
  });

  it('every operation has a tag, a summary, a 200/201/202 answer and security', () => {
    const doc = openapi.document();
    const tags = new Set(doc.tags.map(t => t.name));
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const where = `${method.toUpperCase()} ${p}`;
        expect(op.summary, where).toBeTruthy();
        expect(op.tags && op.tags.length, where).toBeTruthy();
        for (const t of op.tags) expect(tags.has(t), `${where} tag ${t}`).toBe(true);
        expect(Object.keys(op.responses).some(s => ['200', '201', '202'].includes(s)), where).toBe(true);
        if (op.security) expect(op.security.every(s => Object.keys(s).every(k => doc.components.securitySchemes[k])), where).toBe(true);
      }
    }
    expect(doc.components.securitySchemes.apiKey.scheme).toBe('bearer');
    expect(doc.components.schemas.Error).toBeTruthy();
  });

  it('documents every webhook event the service can emit', () => {
    const doc = openapi.document();
    const { EVENTS } = require('../src/services/webhooks');
    for (const ev of EVENTS) expect(doc.webhooks[ev], ev).toBeTruthy();
    expect(doc.webhooks.ping).toBeTruthy();
    const raised = doc.webhooks['alarm.raised'].post;
    const headerNames = (raised.parameters || []).filter(x => x.in === 'header').map(x => x.name);
    expect(headerNames).toEqual(expect.arrayContaining(['X-ModESP-Event', 'X-ModESP-Delivery', 'X-ModESP-Timestamp', 'X-ModESP-Signature']));
  });

  it('serves the JSON and the Swagger UI page without credentials', async () => {
    const json = await request(app).get('/api/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.1.0');
    expect(json.headers['ratelimit-limit']).toBeTruthy();

    const html = await request(app).get('/api/docs');
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('/api/docs/swagger-ui-bundle.js');
    expect(html.text).not.toMatch(/<script>[^<]/);   // CSP: no inline script

    const init = await request(app).get('/api/docs/init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain("url: '/api/docs/openapi.json'");

    const css = await request(app).get('/api/docs/swagger-ui.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect((await request(app).get('/api/docs/package.json')).status).toBe(404);
    expect((await request(app).get('/api/docs/..%2fpackage.json')).status).toBe(404);
  });

  it('docs/openapi.json is the committed copy of the same document', () => {
    const file = path.resolve(__dirname, '../../docs/openapi.json');
    expect(fs.existsSync(file), 'run `npm run openapi:export`').toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(openapi.document());
  });
});
