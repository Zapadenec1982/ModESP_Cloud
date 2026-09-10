#!/usr/bin/env node
'use strict';

/**
 * docs/FEATURES.md and docs/FEATURES_UA.md must describe the same product.
 *
 * They are two hand-written files, and only one of them gets updated when a
 * feature ships: the English file sat at section 17 while the Ukrainian one had
 * grown to 21 — no billing, no work orders, no integrations, no maintenance
 * hints for anyone reading in English.
 *
 * This compares the numbered sections by number, not by wording: a translation
 * chooses its own words, but «## 20. Білінг» and «## 20. Billing» have to both
 * exist. Unnumbered sections (At a Glance, Technical Stack, the diagram) are
 * left alone — their order differs between the two files on purpose.
 */

const fs   = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');

function sections(file) {
  const out = new Map();
  for (const m of fs.readFileSync(path.join(DOCS, file), 'utf8').matchAll(/^## (\d+)\.\s*(.+)$/gm)) {
    out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

const en = sections('FEATURES.md');
const uk = sections('FEATURES_UA.md');
const problems = [];

for (const [n, title] of uk) if (!en.has(n)) problems.push(`FEATURES.md has no section ${n} — FEATURES_UA.md calls it «${title}»`);
for (const [n, title] of en) if (!uk.has(n)) problems.push(`FEATURES_UA.md has no section ${n} — FEATURES.md calls it «${title}»`);

for (const [n] of en) {
  if (!uk.has(n)) continue;
  const gap = Math.abs(bodyLength('FEATURES.md', n) - bodyLength('FEATURES_UA.md', n));
  const longer = Math.max(bodyLength('FEATURES.md', n), bodyLength('FEATURES_UA.md', n));
  // A translation runs longer or shorter than its source; losing more than half
  // of a section means it was not translated, it was summarised away.
  if (longer > 400 && gap > longer * 0.5) {
    problems.push(`section ${n} is ${bodyLength('FEATURES.md', n)} characters in FEATURES.md and ${bodyLength('FEATURES_UA.md', n)} in FEATURES_UA.md — one of them is missing most of the section`);
  }
}

function bodyLength(file, n) {
  const src = fs.readFileSync(path.join(DOCS, file), 'utf8');
  const start = src.search(new RegExp(`^## ${n}\\.`, 'm'));
  if (start < 0) return 0;
  const rest = src.slice(start);
  const end = rest.slice(1).search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end + 1)).length;
}

if (problems.length) {
  console.error(`docs/FEATURES.md and docs/FEATURES_UA.md are out of step (${problems.length}):\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\nA feature that ships is described in both files, or in neither.');
  process.exit(1);
}
console.log(`FEATURES.md and FEATURES_UA.md describe the same ${en.size} numbered sections.`);
