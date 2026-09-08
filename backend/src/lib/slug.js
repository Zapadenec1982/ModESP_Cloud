'use strict';

/**
 * Organisation slug from a free-text name (plan epic 2.1).
 *
 * The slug is part of every MQTT topic of the organisation
 * (modesp/v1/<slug>/<device>/…) and of the broker ACL, so it must satisfy the
 * same rule POST /tenants enforces: lowercase, [a-z0-9][a-z0-9_-]*, 2–64
 * characters. A name typed in Cyrillic is transliterated (Ukrainian first,
 * then the shared letters), everything else that is not a letter or a digit
 * becomes a hyphen. An empty result falls back to "org".
 */

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'y', э: 'e', ё: 'io',
  '№': ' ',   // "№2" → "-2", not "no2"
};

const MAX_LENGTH = 64;
const MIN_LENGTH = 2;

function slugify(name) {
  const lower = String(name || '').trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (CYRILLIC[ch] !== undefined) out += CYRILLIC[ch];
    else out += ch;
  }
  out = out
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // é → e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
  if (out.length < MIN_LENGTH) out = out ? `${out}-org` : 'org';
  if (!/^[a-z0-9]/.test(out)) out = `o${out}`;
  return out.slice(0, MAX_LENGTH);
}

/**
 * First free slug for `name`: the plain slug, then slug-2, slug-3, … `taken`
 * answers whether a candidate is already used (a query, in practice).
 */
async function uniqueSlug(name, taken, { reserved = new Set() } = {}) {
  const base = slugify(name);
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    const candidate = `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    if (reserved.has(candidate)) continue;
    if (!await taken(candidate)) return candidate;
  }
  throw new Error('No free slug found');
}

module.exports = { slugify, uniqueSlug };
