#!/usr/bin/env node
'use strict';

/**
 * Write the OpenAPI document to docs/openapi.json, or with --check verify
 * that the committed file matches the code (CI). The document is built from
 * src/openapi without a database or a running server.
 *
 *   node scripts/openapi-export.js          # write
 *   node scripts/openapi-export.js --check  # exit 1 when docs/openapi.json is stale
 */

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../../docs/openapi.json');
const json = JSON.stringify(require('../src/openapi').document(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error(`docs/openapi.json is out of date — run \`npm run openapi:export\` in backend/ and commit the result`);
    process.exit(1);
  }
  const doc = JSON.parse(json);
  console.log(`docs/openapi.json is current: ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.webhooks || {}).length} webhook events`);
} else {
  fs.writeFileSync(OUT, json);
  const doc = JSON.parse(json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.webhooks || {}).length} webhook events`);
}
