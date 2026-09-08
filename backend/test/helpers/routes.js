'use strict';

/**
 * Walk an Express 4 app and list every registered route as
 * { method, path } with the mount prefixes applied (e.g. GET /api/devices/:id).
 * Used by openapi.test.js to prove the documented surface exists.
 */

function mountPath(layer) {
  if (layer.path !== undefined) return layer.path;
  if (layer.regexp && layer.regexp.fast_slash) return '';
  // express 4 stores the mount as /^\/api\/devices\/?(?=\/|$)/i
  let src = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
  if (src.endsWith('$')) src = src.slice(0, -1);
  return src;
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: join(prefix, p) });
        }
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, join(prefix, mountPath(layer)), out);
    }
  }
  return out;
}

function join(a, b) {
  if (!b || b === '/') return a || '/';
  return (a || '') + (b.startsWith('/') ? b : '/' + b);
}

function listRoutes(app) {
  return walk(app._router.stack, '', []);
}

/** '/devices/{id}/telemetry' → a matcher for express paths like '/api/devices/:id/telemetry'. */
function documentedToExpress(path) {
  return '/api' + path.replace(/\{([^}]+)\}/g, ':$1');
}

module.exports = { listRoutes, documentedToExpress };
