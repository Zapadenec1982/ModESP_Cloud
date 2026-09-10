'use strict';

// globals: true in vitest.config.js
//
// Every router the application mounts is reachable from some test.
//
// A router that no test app mounts cannot be tested, and nothing says so: the
// suite stays green, the coverage report never mentions the file, and the gap is
// visible only to someone who diffs src/index.js against the test helpers by
// hand. That is how the whole device_models router — create, rename, delete, and
// the power figures every energy estimate reads — reached production with zero
// tests.
//
// Most routers are wired into test/helpers/app.js; three (map, geo, geo-stats)
// build their own app because they need the third-party services stubbed
// differently. Either counts: the question is only whether some test can reach
// the router at all.

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Router modules a file mounts: require('…/routes/x') → 'x'. */
function routersIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/routes\/([\w-]+)'\)/g)) out.add(m[1]);
  return out;
}

describe('every mounted router is reachable from a test', () => {
  it('src/index.js mounts nothing that no test app does', () => {
    const app = routersIn(fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8'));

    let testText = fs.readFileSync(path.join(ROOT, 'test', 'helpers', 'app.js'), 'utf8');
    for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
      if (f.endsWith('.test.js')) testText += fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    }
    const reachable = routersIn(testText);

    const unreachable = [...app].filter(r => !reachable.has(r)).sort();
    expect(unreachable).toEqual([]);
  });
});
