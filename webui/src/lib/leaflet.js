/**
 * Single Leaflet entry point for the whole app.
 *
 * Import order is load-bearing and must never be reshuffled:
 *   1. `leaflet` itself — `leaflet-src.js` ends with `window.L = exports`, which is
 *      the global both plugins below read at module top level.
 *   2. `leaflet.markercluster` / `leaflet.heat` — neither imports Leaflet; they
 *      extend the bare global `L` while they evaluate. Loaded before step 1 they
 *      throw `L is not defined` and the map never mounts.
 *
 * Every map component imports `L` from THIS module and never from `leaflet`
 * directly, so no editor auto-sort or lint rule can move a plugin ahead of the
 * core import in some other file.
 *
 * The CSS is imported here too (Vite-safe — both stylesheets are plain rules with
 * no `url()` references; `leaflet.heat` ships no CSS). App-level theming of the
 * Leaflet chrome lives in `components/map/MapCanvas.svelte`.
 */

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import 'leaflet.heat'

export default L
