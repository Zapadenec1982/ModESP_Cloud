'use strict';

/**
 * Public API documentation (plan epic 2.6).
 *   GET /docs               Swagger UI, self-hosted (swagger-ui-dist), no CDN
 *   GET /docs/openapi.json  the OpenAPI 3.1 document
 *   GET /docs/<asset>       the UI bundle, stylesheet and init script
 *
 * Mounted above the JWT gate: the description of the API is not a secret,
 * and an integrator reads it before they have a key. Rate-limited per IP.
 */

const path = require('path');
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const openapi = require('../openapi');

const router = Router();
const SWAGGER_DIR = require('swagger-ui-dist').getAbsoluteFSPath();
const ASSETS = new Set(['swagger-ui.css', 'swagger-ui-bundle.js', 'favicon-32x32.png', 'favicon-16x16.png']);

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many requests, try again later', status: 429 },
}));

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ModESP Cloud API</title>
  <link rel="stylesheet" href="/api/docs/swagger-ui.css">
  <link rel="icon" type="image/png" href="/api/docs/favicon-32x32.png" sizes="32x32">
  <link rel="icon" type="image/png" href="/api/docs/favicon-16x16.png" sizes="16x16">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script src="/api/docs/init.js"></script>
</body>
</html>
`;

// The CSP allows scripts from 'self' only, so the initialisation lives in its
// own file rather than inline.
const INIT = `window.addEventListener('DOMContentLoaded', function () {
  window.ui = SwaggerUIBundle({
    url: '/api/docs/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    displayRequestDuration: true,
    tryItOutEnabled: false,
    defaultModelsExpandDepth: 0,
    docExpansion: 'list',
    filter: true,
  });
});
`;

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(PAGE);
});

router.get('/openapi.json', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(openapi.document());
});

router.get('/init.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/javascript').send(INIT);
});

router.get('/:asset', (req, res) => {
  if (!ASSETS.has(req.params.asset)) return res.status(404).json({ error: 'not_found', message: 'Not found', status: 404 });
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.sendFile(path.join(SWAGGER_DIR, req.params.asset));
});

module.exports = router;
