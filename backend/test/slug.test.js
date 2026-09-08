'use strict';

// globals: true in vitest.config.js — pure unit tests, no database.

const { slugify, uniqueSlug } = require('../src/lib/slug');

describe('slugify (plan epic 2.1)', () => {
  it('transliterates Ukrainian and keeps only [a-z0-9-]', () => {
    expect(slugify('Кафе «Полярний» №2')).toBe('kafe-poliarnyi-2');
    expect(slugify('ТОВ "Холод-Сервіс"')).toBe('tov-kholod-servis');
    expect(slugify('Їжак і Ґудзик')).toBe('izhak-i-gudzyk');
    expect(slugify('Щедрий Юрій')).toBe('shchedryi-iurii');
  });

  it('strips diacritics and collapses separators', () => {
    expect(slugify('  Świeży  Rynek  ')).toBe('swiezy-rynek');
    expect(slugify('Kühlhaus Müller GmbH')).toBe('kuhlhaus-muller-gmbh');
    expect(slugify('Fresh --- Market!!!')).toBe('fresh-market');
  });

  it('never returns something the tenant slug rule refuses', () => {
    expect(slugify('')).toBe('org');
    expect(slugify('!!!')).toBe('org');
    expect(slugify('Я')).toBe('ia');
    expect(slugify('7')).toBe('7-org');
    expect(slugify('-x-')).toBe('x-org');
    const long = slugify('a'.repeat(100));
    expect(long).toHaveLength(64);
    for (const v of ['Кафе', 'Fresh Market', '-a-', '42', 'ß']) {
      expect(slugify(v)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      expect(slugify(v).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('uniqueSlug appends -2, -3 … past taken and reserved names', async () => {
    const taken = new Set(['fresh-market', 'fresh-market-2']);
    expect(await uniqueSlug('Fresh Market', async s => taken.has(s))).toBe('fresh-market-3');
    expect(await uniqueSlug('Admin', async () => false, { reserved: new Set(['admin']) })).toBe('admin-2');
    expect(await uniqueSlug('New Org', async () => false)).toBe('new-org');
  });

  it('keeps the suffix inside the 64-character limit', async () => {
    const base = slugify('b'.repeat(80));
    const s = await uniqueSlug('b'.repeat(80), async x => x === base);
    expect(s).toHaveLength(64);
    expect(s.endsWith('-2')).toBe(true);
  });
});
