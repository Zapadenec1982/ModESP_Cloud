'use strict';

/**
 * Geocoder proxy — mounted at /api/geo (see src/index.js).
 *
 * The browser must NEVER call Nominatim directly: the OSM usage policy requires
 * one identifying User-Agent, one rate limiter and one cache per application.
 * Both endpoints below are thin, validated wrappers over services/geocode.js —
 * they never proxy an arbitrary URL, and the caller cannot influence anything
 * beyond the query string / coordinates the service builds its own URL from.
 *
 * Rate limiting is applied in index.js (`externalLimiter`, keyed on the user id).
 * Any authenticated user may call these — the address autocomplete is needed by
 * every role that can see a site, so no extra `authorize()` is mounted here.
 */

const { Router } = require('express');
const { z }      = require('zod');
const geocodeSvc = require('../services/geocode');

const router = Router();

// ── Validation ───────────────────────────────────────────

/**
 * Numeric query parameter as a *string* first: z.coerce.number() turns an empty
 * `?lat=` into 0, which is a valid latitude and would silently geocode Null Island.
 */
const numParam = (label, min, max) =>
  z.string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .refine(v => Number.isFinite(Number(v)), `${label} must be a number`)
    .transform(Number)
    .refine(n => n >= min && n <= max, `${label} must be between ${min} and ${max}`);

const searchSchema = z.object({
  // 200 chars is the cap services/geocode.js applies upstream; reject earlier so
  // the caller gets a validation error instead of a silently truncated query.
  q:     z.string().trim().min(1, 'q is required').max(200, 'q must be at most 200 characters'),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

const reverseSchema = z.object({
  lat: numParam('lat', -90, 90),
  lon: numParam('lon', -180, 180),
});

function validationError(res, parsed) {
  return res.status(400).json({
    error: 'validation_failed',
    message: parsed.error.issues[0]?.message || 'Invalid input',
    status: 400,
  });
}

// ── GET /api/geo/search ──────────────────────────────────
// Free-text address autocomplete. Free-form `q` is only appropriate here, where
// the user types arbitrary text; site geocoding uses the structured query built
// inside services/geocode.js.
router.get('/search', async (req, res, next) => {
  const parsed = searchSchema.safeParse({ q: req.query.q, limit: req.query.limit });
  if (!parsed.success) return validationError(res, parsed);

  try {
    // search() never rejects: a disabled provider, a timeout or a 5xx all come
    // back as [] so the autocomplete degrades to a plain text field.
    const rows = await geocodeSvc.search(parsed.data.q, {
      limit: parsed.data.limit ?? 5,
      lane:  'interactive',
    });

    res.json({
      data: Array.isArray(rows) ? rows : [],
      // Lets the UI hide the autocomplete entirely instead of showing a box that
      // never answers (GEOCODER_PROVIDER=none / unset).
      meta: { enabled: geocodeSvc.isEnabled() },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/geo/reverse ─────────────────────────────────
// Coordinates → address, for the draggable marker in AddressPicker.
router.get('/reverse', async (req, res, next) => {
  const parsed = reverseSchema.safeParse({ lat: req.query.lat, lon: req.query.lon });
  if (!parsed.success) return validationError(res, parsed);

  try {
    const result = await geocodeSvc.reverse(parsed.data.lat, parsed.data.lon, { lane: 'interactive' });

    res.json({
      data: result || null,
      meta: { enabled: geocodeSvc.isEnabled() },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
