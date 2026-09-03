#!/usr/bin/env node
'use strict';
/**
 * docs/legal/*.md -> landing/legal/*.html (plan epic 1.11).
 *
 * A deliberately small Markdown subset (headings, paragraphs, lists, block
 * quotes, tables, bold/italic/code/links, rules) so the landing needs no
 * dependency. Run by infra/scripts/build-release.sh; the outputs are committed
 * too, so a git checkout serves them as well. Re-run after editing a draft:
 *   node infra/scripts/build-legal.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'docs', 'legal');
const OUT = path.join(ROOT, 'landing', 'legal');
const MAP = {
  'PUBLIC-OFFER_UA.md':        'offer',
  'PRIVACY-POLICY_UA.md':      'privacy',
  'SERVICE-DESCRIPTION_UA.md': 'service',
  'DPA_UA.md':                 'dpa',
  'PARTNER-AGREEMENT_UA.md':   'partner',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let t = esc(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|mailto:|\/|#)/.test(href) ? href : '#';
    return `<a href="${esc(safe)}" rel="noopener">${label}</a>`;
  });
  return t;
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0, para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushAll(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
      flushAll();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      out.push('<table><thead><tr>' + cells(line).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { out.push('<tr>' + cells(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>'); i++; }
      out.push('</tbody></table>');
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara(); flushQuote();
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[1])}</li>`); i++; continue;
    }
    if (line.trim() === '') { flushAll(); i++; continue; }
    if (list && /^\s{2,}/.test(line)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); i++; continue; }
    flushList(); flushQuote(); para.push(line.trim()); i++;
  }
  flushAll();
  return out.join('\n');
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ModESP Cloud</title>
<meta name="description" content="${esc(title)} — ModESP Cloud, хмарний моніторинг холодильного обладнання.">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="doc">
<a class="back" href="/">← ModESP Cloud</a>
${body}
</main>
</body>
</html>
`;
}

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [file, slug] of Object.entries(MAP)) {
  const src = path.join(SRC, file);
  if (!fs.existsSync(src)) { console.warn(`skip ${file}: not found`); continue; }
  const md = fs.readFileSync(src, 'utf8');
  const title = (md.match(/^#\s+(.*)$/m) || [null, slug])[1];
  fs.writeFileSync(path.join(OUT, `${slug}.html`), page(title, render(md)));
  n++;
}
console.log(`legal pages: ${n} written to ${path.relative(ROOT, OUT)}`);
