'use strict';

/**
 * Typical HACCP critical limits by what the equipment stores.
 *
 * Starting points, not law: the enterprise's own HACCP plan (and the product
 * label) set the critical limit; these presets save typing the same numbers
 * into two hundred device cards. A preset fills haccp_min / haccp_max /
 * haccp_tolerance and, unless the caller gives their own, haccp_product with
 * the localised label. Used by the device card (select), the bulk action on
 * the dashboard (PATCH /devices/haccp) and the CSV import (column haccp_preset).
 *
 * tolerance — the allowed deviation past the limit before the journal counts
 * an excursion (EU frozen-food practice allows brief rises of up to 3 °C;
 * pharmaceutical cold chain allows none).
 */

const PRESETS = [
  { key: 'freezer', min: null, max: -18, tolerance: 3,
    label: { uk: 'Заморожені продукти', en: 'Frozen food', pl: 'Produkty mrożone', de: 'Tiefkühlware' } },
  { key: 'ice_cream', min: null, max: -18, tolerance: 2,
    label: { uk: 'Морозиво', en: 'Ice cream', pl: 'Lody', de: 'Speiseeis' } },
  { key: 'chilled', min: 0, max: 6, tolerance: 2,
    label: { uk: 'Охолоджені продукти', en: 'Chilled food', pl: 'Produkty schłodzone', de: 'Gekühlte Lebensmittel' } },
  { key: 'meat', min: 0, max: 4, tolerance: 1,
    label: { uk: 'Свіже мʼясо та птиця', en: 'Fresh meat and poultry', pl: 'Świeże mięso i drób', de: 'Frischfleisch und Geflügel' } },
  { key: 'fish', min: 0, max: 2, tolerance: 1,
    label: { uk: 'Свіжа риба', en: 'Fresh fish', pl: 'Świeże ryby', de: 'Frischer Fisch' } },
  { key: 'dairy', min: 2, max: 6, tolerance: 2,
    label: { uk: 'Молочна продукція', en: 'Dairy', pl: 'Nabiał', de: 'Milchprodukte' } },
  { key: 'produce', min: 2, max: 10, tolerance: 2,
    label: { uk: 'Овочі та фрукти', en: 'Fruit and vegetables', pl: 'Owoce i warzywa', de: 'Obst und Gemüse' } },
  { key: 'pharma', min: 2, max: 8, tolerance: 0,
    label: { uk: 'Лікарські засоби (2–8 °C)', en: 'Medicines (2–8 °C)', pl: 'Leki (2–8 °C)', de: 'Arzneimittel (2–8 °C)' } },
];

const KEYS = PRESETS.map(p => p.key);
const byKey = new Map(PRESETS.map(p => [p.key, p]));

function presetOf(key) {
  return byKey.get(String(key || '').trim().toLowerCase()) || null;
}

/** The device columns a preset sets; the product label in the given language. */
function fieldsOf(key, lang = 'uk') {
  const p = presetOf(key);
  if (!p) return null;
  return { haccp_min: p.min, haccp_max: p.max, haccp_tolerance: p.tolerance, haccp_product: p.label[lang] || p.label.uk };
}

module.exports = { PRESETS, KEYS, presetOf, fieldsOf };
