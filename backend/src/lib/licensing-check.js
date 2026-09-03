'use strict';

/**
 * Third-party geo licensing guard (plan epic 1.2).
 *
 * Nominatim's public endpoint, the OSRM demo server, Open-Meteo's free tier and
 * the public OSM tile servers are free for NON-commercial use only. ModESP
 * Cloud is a commercial product, so a production process must not start with
 * any of them configured — unless the operator says so explicitly with
 * ALLOW_NONCOMMERCIAL_GEO=true (a demo server, a pilot on one's own risk).
 *
 * Pure: takes an env object, returns findings; index.js decides what to do.
 */

const NONCOMMERCIAL = {
  geocoder: ['nominatim.openstreetmap.org'],
  routing:  ['router.project-osrm.org'],
  weather:  ['api.open-meteo.com'],
  tiles:    ['tile.openstreetmap.org', 'a.tile.openstreetmap.org', 'b.tile.openstreetmap.org', 'c.tile.openstreetmap.org'],
};

const off = (v) => { const s = (v || '').trim().toLowerCase(); return s === '' || s === 'none'; };

function hostOf(url) {
  try { return new URL(String(url || '').trim()).hostname.toLowerCase(); } catch { return null; }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ enabled: string[], violations: Array<{service:string, host:string, fix:string}> }}
 */
function checkGeoLicensing(env = process.env) {
  const enabled = [], violations = [];

  if (!off(env.GEOCODER_PROVIDER)) {
    const host = hostOf(env.GEOCODER_URL || 'https://nominatim.openstreetmap.org');
    enabled.push(`Nominatim (${host})`);
    if (NONCOMMERCIAL.geocoder.includes(host)) {
      violations.push({ service: 'geocoder', host, fix: 'self-host Nominatim (infra/geo) and set GEOCODER_URL, or GEOCODER_PROVIDER=none' });
    }
  }
  if (!off(env.OSRM_URL)) {
    const host = hostOf(env.OSRM_URL);
    enabled.push(`OSRM (${host})`);
    if (NONCOMMERCIAL.routing.includes(host)) {
      violations.push({ service: 'routing', host, fix: 'self-host OSRM (infra/geo) and set OSRM_URL, or leave OSRM_URL empty' });
    }
  }
  if (!off(env.WEATHER_PROVIDER)) {
    const host = hostOf(env.WEATHER_URL || 'https://api.open-meteo.com/v1');
    enabled.push(`Open-Meteo (${host})`);
    if (NONCOMMERCIAL.weather.includes(host) && !(env.WEATHER_API_KEY || '').trim()) {
      violations.push({ service: 'weather', host, fix: 'buy an Open-Meteo plan and set WEATHER_API_KEY, or WEATHER_PROVIDER=none' });
    }
  }
  if ((env.ORS_API_KEY || '').trim()) enabled.push('OpenRouteService (isochrones)');
  const tileHosts = (env.MAP_TILE_HOSTS || '').split(',').map(s => hostOf(s.trim()) || s.trim().toLowerCase()).filter(Boolean);
  for (const host of tileHosts) {
    if (NONCOMMERCIAL.tiles.includes(host) || host.endsWith('.tile.openstreetmap.org')) {
      violations.push({ service: 'tiles', host, fix: 'use a paid tile provider: MAP_TILE_HOSTS + VITE_MAP_TILE_URL (webui/.env)' });
      break;
    }
  }
  return { enabled, violations };
}

/**
 * Log the findings; in production without ALLOW_NONCOMMERCIAL_GEO=true a
 * violation is fatal. Returns true when the process may continue.
 */
function enforce({ env = process.env, logger }) {
  const { enabled, violations } = checkGeoLicensing(env);
  const production = env.NODE_ENV === 'production';
  const allowed = (env.ALLOW_NONCOMMERCIAL_GEO || '').trim() === 'true';
  if (violations.length === 0) {
    if (enabled.length && logger) logger.info({ services: enabled }, 'Third-party geo services configured (licensed or self-hosted)');
    return true;
  }
  const msg = 'Third-party geo services under free / non-commercial terms are configured. See docs/THIRD_PARTY_LICENSING.md';
  if (production && !allowed) {
    if (logger) logger.fatal({ violations }, `${msg} — refusing to start in production (set ALLOW_NONCOMMERCIAL_GEO=true to override knowingly)`);
    return false;
  }
  if (logger) logger.warn({ violations, allowed }, production ? `${msg} — running because ALLOW_NONCOMMERCIAL_GEO=true` : msg);
  return true;
}

module.exports = { checkGeoLicensing, enforce, NONCOMMERCIAL };
