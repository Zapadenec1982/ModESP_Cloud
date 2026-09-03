'use strict';

// globals: true in vitest.config.js
const { checkGeoLicensing, enforce } = require('../src/lib/licensing-check');

const silent = { info() {}, warn() {}, fatal() {} };

describe('third-party geo licensing guard (plan epic 1.2)', () => {
  it('flags every public non-commercial endpoint that is enabled', () => {
    const r = checkGeoLicensing({
      GEOCODER_PROVIDER: 'nominatim', GEOCODER_URL: 'https://nominatim.openstreetmap.org',
      OSRM_URL: 'https://router.project-osrm.org',
      WEATHER_PROVIDER: 'open-meteo', WEATHER_URL: 'https://api.open-meteo.com/v1',
      MAP_TILE_HOSTS: 'https://tile.openstreetmap.org,https://*.tile.openstreetmap.org',
    });
    expect(r.violations.map(v => v.service).sort()).toEqual(['geocoder', 'routing', 'tiles', 'weather']);
  });

  it('accepts self-hosted instances, a paid weather key and a paid tile provider', () => {
    const r = checkGeoLicensing({
      GEOCODER_PROVIDER: 'nominatim', GEOCODER_URL: 'http://127.0.0.1:8080',
      OSRM_URL: 'http://127.0.0.1:5000',
      WEATHER_PROVIDER: 'open-meteo', WEATHER_API_KEY: 'k',
      MAP_TILE_HOSTS: 'https://api.maptiler.com',
    });
    expect(r.violations).toEqual([]);
    expect(r.enabled.length).toBe(3);
  });

  it('disabled services never violate', () => {
    const r = checkGeoLicensing({ GEOCODER_PROVIDER: 'none', OSRM_URL: '', WEATHER_PROVIDER: '', MAP_TILE_HOSTS: '' });
    expect(r).toEqual({ enabled: [], violations: [] });
  });

  it('refuses to start in production, unless overridden; only warns elsewhere', () => {
    const bad = { NODE_ENV: 'production', OSRM_URL: 'https://router.project-osrm.org' };
    expect(enforce({ env: bad, logger: silent })).toBe(false);
    expect(enforce({ env: { ...bad, ALLOW_NONCOMMERCIAL_GEO: 'true' }, logger: silent })).toBe(true);
    expect(enforce({ env: { ...bad, NODE_ENV: 'development' }, logger: silent })).toBe(true);
    expect(enforce({ env: { NODE_ENV: 'production', OSRM_URL: 'http://127.0.0.1:5000' }, logger: silent })).toBe(true);
  });
});
