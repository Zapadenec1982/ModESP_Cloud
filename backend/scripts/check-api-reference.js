#!/usr/bin/env node
'use strict';

/**
 * docs/API_REFERENCE.md against the routes Express actually mounts.
 *
 * The reference is the hand-written manual — it carries the accounting and
 * administrative surface OpenAPI leaves out, so nothing generates it and it
 * drifts silently: an endpoint gets renamed, a section survives a rewrite it
 * no longer describes. This walks every `app.use('/api/…', router)` in
 * src/index.js, asks each router which paths it holds, and compares that with
 * the `### \`METHOD /path\`` headings in the manual.
 *
 * Parameter names are ignored on both sides (`/devices/:id` and
 * `/devices/:deviceId` are the same endpoint to a reader); the method and the
 * shape of the path are not.
 *
 * Endpoints that exist on purpose but need no section of their own live in
 * UNDOCUMENTED_ON_PURPOSE below, each with the reason.
 */

const fs   = require('fs');
const path = require('path');

const SRC   = path.join(__dirname, '..', 'src');
const DOC   = path.join(__dirname, '..', '..', 'docs', 'API_REFERENCE.md');

/** Real endpoints that deliberately have no section in the manual. */
const UNDOCUMENTED_ON_PURPOSE = new Map([
  ['GET /api/health',              'liveness probe, described in DEPLOYMENT.md'],
  ['GET /api/health/details',      'liveness probe, described in DEPLOYMENT.md'],
  ['GET /api/docs',                'the OpenAPI UI itself, described in the preamble'],
  ['GET /api/docs/openapi.json',   'the OpenAPI document, described in the preamble'],
  ['GET /api/docs/init.js',        'asset of the OpenAPI UI'],
  ['GET /api/docs/:_',             'asset of the OpenAPI UI'],
]);

/** `/devices/:id/x` → `/devices/:_/x`: the manual may name a parameter differently. */
function shape(p) {
  return p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_').replace(/\/+$/, '') || '/';
}

// ── What the code mounts ────────────────────────────────────────────────

/** `router.use('/admin', sub)` keeps its prefix only in the layer regexp. */
function prefixOf(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)\$?$/.exec(layer.regexp.source);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

/** Every path a router answers, sub-routers included. */
function walk(router, prefix, out) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      const full = (prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(/\/+$/, '') || '/';
      for (const method of Object.keys(layer.route.methods)) {
        out.set(`${method.toUpperCase()} ${shape(full)}`, `${method.toUpperCase()} ${full}`);
      }
    } else if (layer.handle && layer.handle.stack) {
      walk(layer.handle, prefix + prefixOf(layer), out);
    }
  }
}

function realEndpoints() {
  const src  = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const vars = new Map();
  const out  = new Map();

  // const NAME = require('./routes/x')          const NAME = require('./routes/x').prop
  for (const m of src.matchAll(/^const\s+(\w+)\s*=\s*require\('(\.\/routes\/[\w-]+)'\)(?:\.(\w+))?/gm)) {
    vars.set(m[1], { mod: m[2], prop: m[3] || null });
  }
  // const { a: x, b } = require('./routes/x')
  for (const m of src.matchAll(/^const\s*\{([^}]+)\}\s*=\s*require\('(\.\/routes\/[\w-]+)'\)/gm)) {
    for (const part of m[1].split(',')) {
      const [key, alias] = part.split(':').map(s => s.trim());
      if (key) vars.set(alias || key, { mod: m[2], prop: key });
    }
  }

  // app.get('/api/meta', …) — a handful of endpoints live straight on the app
  for (const m of src.matchAll(/^\s*app\.(get|post|patch|put|delete)\(\s*'(\/api[^']*)'/gm)) {
    const full = m[2].replace(/\/+$/, '');
    out.set(`${m[1].toUpperCase()} ${shape(full)}`, `${m[1].toUpperCase()} ${full}`);
  }

  for (const m of src.matchAll(/^\s*app\.use\(\s*'(\/api[^']*)'\s*,([^\n]*)\)/gm)) {
    const prefix = m[1], rest = m[2];
    let mount = null;
    const inline = rest.match(/require\('(\.\/routes\/[\w-]+)'\)(?:\.(\w+))?/);
    if (inline) mount = { mod: inline[1], prop: inline[2] || null };
    else for (const ref of rest.matchAll(/\b(\w+)(?:\.(\w+))?\b/g)) {
      const base = vars.get(ref[1]);
      if (base) { mount = { mod: base.mod, prop: ref[2] || base.prop }; break; }
    }
    if (!mount) continue;
    let router = require(path.join(SRC, mount.mod));
    if (mount.prop) router = router[mount.prop];
    if (router && router.stack) walk(router, prefix, out);
  }
  return out;
}

// ── What the manual documents ───────────────────────────────────────────
function documentedEndpoints() {
  const md    = fs.readFileSync(DOC, 'utf8');
  const found = new Map();   // shaped endpoint → the heading as written
  // A heading may carry several endpoints: `PATCH /x/:id` · `DELETE /x/:id`
  for (const line of md.split('\n')) {
    if (!/^#+ `[A-Z]+ /.test(line)) continue;
    for (const m of line.matchAll(/`([A-Z]+) ([^`]+)`/g)) {
      let p = m[2].trim().split(/\s+/)[0].replace(/[?[].*$/, '');
      if (!p.startsWith('/api/') && p !== '/api') p = '/api' + p;
      found.set(`${m[1]} ${shape(p)}`, `${m[1]} ${m[2].trim()}`);
    }
  }
  return found;
}

function main() {
  const real = realEndpoints();
  const doc  = documentedEndpoints();
  const problems = [];

  for (const [key, written] of doc) {
    if (!real.has(key)) problems.push(`documented but not mounted: ${written}`);
  }
  for (const [key, written] of real) {
    if (doc.has(key) || UNDOCUMENTED_ON_PURPOSE.has(key)) continue;
    problems.push(`mounted but not documented: ${written}`);
  }

  const base = fs.readFileSync(DOC, 'utf8').match(/^\*\*Base URL:\*\* `([^`]+)`/m);
  if (base && /\/api\/v\d/.test(base[1])) {
    problems.push(`the base address says ${base[1]}, but the code mounts everything under /api with no version segment`);
  }

  if (problems.length) {
    console.error(`docs/API_REFERENCE.md does not match the code (${problems.length}):\n`);
    for (const p of problems.sort()) console.error('  ' + p);
    console.error('\nFix the manual, or — for an endpoint that needs no section — name it in');
    console.error('UNDOCUMENTED_ON_PURPOSE in backend/scripts/check-api-reference.js with the reason.');
    process.exit(1);
  }
  console.log(`docs/API_REFERENCE.md matches the code: ${real.size} endpoints mounted, ${doc.size} documented.`);
}

main();
