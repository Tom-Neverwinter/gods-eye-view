import * as Cesium from 'cesium';

/**
 * @file Live weather radar and satellite cloud-cover overlays (#85), drawn on
 * the Cesium GLOBE surface — same "small array of descriptors" shape as
 * `osmOverlays.js` (#10), and the same polling/abort pattern as
 * `nifcWildfires.js`. Public, CORS-open, keyless RainViewer API (confirmed
 * live 2026-08-29: https://api.rainviewer.com/public/weather-maps.json and
 * its tile host both send `access-control-allow-origin: *`), fetched
 * directly from the browser like earthquakes.js fetches USGS — no server
 * proxy needed.
 *
 * Scoped to what RainViewer's one free, keyless endpoint actually provides:
 * the latest precipitation-radar frame (global mosaic) and the latest
 * infrared satellite frame. The full #85 proposal also names region-specific
 * sources (NOAA MRMS, EUMETSAT) and an animated multi-frame time slider —
 * deliberately out of scope for this pass; RainViewer's `radar.past` array
 * already carries the last ~2h of frames if a future pass wants to add
 * animation on top of this same tile-URL-building code.
 *
 * Like the OSM overlays, this draws on `viewer.scene.globe`, not the Google
 * Photorealistic 3D Tiles mesh — visible on the `osm`/`bing-aerial`/
 * `bing-labels` map stacks, invisible (not broken) on the default
 * `photoreal` stack.
 * @module data/weatherOverlay
 */

const API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
// RainViewer publishes a new radar frame roughly every 10 minutes; polling
// faster would just re-fetch the same frame.
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const TILE_SIZE = 256;

export const WEATHER_OVERLAY_LAYER_ID = 'weather-overlay';

/** @type {Array<{key:string,label:string,icon:string,framesPath:string[],colorScheme:number,options:string,credit:string}>} */
export const WEATHER_OVERLAYS = Object.freeze([
  Object.freeze({
    key: 'radar',
    label: 'Precip Radar',
    icon: '🌧️',
    framesPath: ['radar', 'past'],
    colorScheme: 2, // "Universal Blue" — reads as a familiar radar reflectivity palette
    options: '1_1', // smooth edges, distinct snow color
    credit: 'Weather radar: © RainViewer',
  }),
  Object.freeze({
    key: 'satellite',
    label: 'Cloud Cover',
    icon: '☁️',
    framesPath: ['satellite', 'infrared'],
    colorScheme: 0,
    options: '0_0',
    credit: 'Satellite (IR): © RainViewer',
  }),
]);

const DEFAULT_PARAMS = Object.freeze({
  // Satellite coverage on RainViewer's free endpoint is intermittently empty
  // (observed live 2026-08-29) — default it off so switching the row on
  // doesn't default to a chip that shows nothing yet. Radar has been
  // reliably populated, so it defaults on like the OSM overlays do.
  radar: true,
  satellite: false,
});

/**
 * Pick the most recent frame from a RainViewer frame-time array (chronological,
 * oldest first — confirmed live 2026-08-29).
 * @param {Array<{time:number,path:string}>|undefined} frames
 * @returns {{time:number,path:string}|null}
 */
export function pickLatestFrame(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  return frames[frames.length - 1];
}

/**
 * Parse a raw `weather-maps.json` response into `{host, generated, frames}`,
 * where `frames` maps each overlay key to its latest frame (or null).
 * @param {*} json
 * @returns {{host:string, generated:number|null, frames:Record<string,{time:number,path:string}|null>}|null}
 */
export function parseWeatherMapsResponse(json) {
  const host = typeof json?.host === 'string' && json.host ? json.host : null;
  if (!host) return null;
  const frames = {};
  for (const overlay of WEATHER_OVERLAYS) {
    const section = overlay.framesPath.reduce((node, key) => node?.[key], json);
    frames[overlay.key] = pickLatestFrame(section);
  }
  const generated = Number.isFinite(json?.generated) ? json.generated * 1000 : null;
  return { host, generated, frames };
}

/**
 * Build the Cesium `UrlTemplateImageryProvider` URL for one overlay's frame.
 * @param {string} host
 * @param {{key:string,colorScheme:number,options:string}} overlay
 * @param {{path:string}} frame
 * @returns {string}
 */
export function buildOverlayUrlTemplate(host, overlay, frame) {
  return `${host}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${overlay.colorScheme}/${overlay.options}.png`;
}

/** Reason an enabled, chosen overlay is currently showing nothing, or null. */
export function weatherOverlayHiddenReason(enabled, params, globeShown) {
  if (!enabled) return null;
  const anyChosen = WEATHER_OVERLAYS.some((overlay) => Boolean(params?.[overlay.key]));
  if (!anyChosen) return null;
  if (globeShown) return null;
  return 'Overlays draw on the globe surface — switch the map stack to OSM or Bing (not Google 3D) to see them';
}

/**
 * Sanitize a candidate params object against the two known overlay keys.
 * Same convention as `applyOsmOverlayParams`: unknown keys ignored, a
 * non-boolean value for a known key leaves it untouched.
 * @param {object} current
 * @param {object} candidate
 * @returns {{next: object, changed: boolean}}
 */
export function applyWeatherOverlayParams(current, candidate = {}) {
  const next = { ...current };
  let changed = false;
  for (const overlay of WEATHER_OVERLAYS) {
    if (!Object.hasOwn(candidate, overlay.key)) continue;
    const value = candidate[overlay.key];
    if (typeof value !== 'boolean') continue;
    if (next[overlay.key] !== value) changed = true;
    next[overlay.key] = value;
  }
  return { next, changed };
}

const state = {
  viewer: null,
  enabled: false,
  params: { ...DEFAULT_PARAMS },
  imageryLayers: new Map(),
  frameKeys: new Map(), // overlay key -> frame `time`, so a same-frame poll is a no-op
  generated: null,
  error: null,
  abort: null,
};

function syncImageryLayerVisibility() {
  for (const overlay of WEATHER_OVERLAYS) {
    const layer = state.imageryLayers.get(overlay.key);
    if (layer) layer.show = state.enabled && Boolean(state.params[overlay.key]);
  }
}

/** Swap in a new imagery layer for one overlay's latest frame, preserving its show state. */
function applyOverlayFrame(overlay, host, frame) {
  const previous = state.imageryLayers.get(overlay.key);
  if (previous && state.viewer) {
    state.viewer.imageryLayers.remove(previous, true);
    state.imageryLayers.delete(overlay.key);
  }
  if (!frame || !state.viewer) {
    state.frameKeys.delete(overlay.key);
    return;
  }
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: buildOverlayUrlTemplate(host, overlay, frame),
    credit: overlay.credit,
  });
  const layer = new Cesium.ImageryLayer(provider);
  layer.alpha = 0.6; // semi-transparent overlay per #85, not an opaque base layer
  layer.show = state.enabled && Boolean(state.params[overlay.key]);
  // Appended (no index) so it draws on top of the base map-stack imagery
  // layer mapStackController.js keeps at index 0 — same convention osmOverlays.js uses.
  state.viewer.imageryLayers.add(layer);
  state.imageryLayers.set(overlay.key, layer);
  state.frameKeys.set(overlay.key, frame.time);
}

async function refreshFrames() {
  if (!state.enabled) return;
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  try {
    const response = await fetch(API_URL, { signal: requestAbort.signal });
    // Checked immediately after each await, before any state write — same
    // superseded-poll guard as nifcWildfires.js's loadIncidents().
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    if (!response.ok) {
      state.error = `RainViewer feed HTTP ${response.status}`;
      return;
    }
    const json = await response.json();
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    const parsed = parseWeatherMapsResponse(json);
    if (!parsed) {
      state.error = 'Malformed RainViewer response';
      return;
    }
    for (const overlay of WEATHER_OVERLAYS) {
      const frame = parsed.frames[overlay.key];
      // A same-frame poll is a no-op — don't tear down and rebuild a live
      // ImageryLayer (and re-fetch every visible tile) for nothing.
      if (frame && state.frameKeys.get(overlay.key) === frame.time) continue;
      applyOverlayFrame(overlay, parsed.host, frame);
    }
    state.generated = parsed.generated;
    const anyFrame = WEATHER_OVERLAYS.some((overlay) => parsed.frames[overlay.key]);
    state.error = anyFrame ? null : 'RainViewer returned no current frames';
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    state.error = 'RainViewer feed network error';
  } finally {
    if (state.abort === requestAbort) state.abort = null;
  }
}

const weatherOverlayLayer = {
  id: WEATHER_OVERLAY_LAYER_ID,
  name: 'Weather Radar',
  icon: '🌦️',
  source: 'RainViewer',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
  },
  enable() {
    // No fetch here — the manager calls update() once itself right after
    // enable() resolves (same convention nifcWildfires.js follows), so an
    // explicit call here would just double the initial fetch.
    state.enabled = true;
    syncImageryLayerVisibility();
  },
  disable() {
    state.enabled = false;
    state.abort?.abort();
    state.abort = null;
    syncImageryLayerVisibility();
  },
  update() {
    return refreshFrames();
  },
  setParams(params = {}) {
    const { next, changed } = applyWeatherOverlayParams(state.params, params);
    if (changed) {
      state.params = next;
      syncImageryLayerVisibility();
    }
    return true;
  },
  getParams() {
    return { ...state.params };
  },
  getRowControls() {
    if (!state.enabled) return { chips: [], legend: [] };
    const globeShown = state.viewer?.scene?.globe?.show !== false;
    return {
      chips: WEATHER_OVERLAYS.map((overlay) => {
        const active = Boolean(state.params[overlay.key]);
        const hasFrame = state.imageryLayers.has(overlay.key);
        let title = overlay.credit;
        if (!globeShown) title += ' — needs the OSM or Bing map stack to render, not Google 3D';
        else if (active && !hasFrame) title += ' — no current frame from RainViewer';
        return {
          id: overlay.key,
          label: `${overlay.icon} ${overlay.label}`,
          active,
          title,
          params: { [overlay.key]: !active },
        };
      }),
      legend: [],
    };
  },
  destroy(viewer) {
    this.disable();
    for (const layer of state.imageryLayers.values()) {
      if (viewer) viewer.imageryLayers.remove(layer, true);
    }
    state.imageryLayers.clear();
    state.frameKeys.clear();
    state.viewer = null;
    state.params = { ...DEFAULT_PARAMS };
    state.generated = null;
    state.error = null;
  },
  getStats() {
    const globeShown = state.viewer?.scene?.globe?.show !== false;
    return {
      count: state.enabled
        ? WEATHER_OVERLAYS.filter((overlay) => state.params[overlay.key] && state.imageryLayers.has(overlay.key)).length
        : 0,
      lastUpdate: state.generated,
      error: weatherOverlayHiddenReason(state.enabled, state.params, globeShown) || state.error,
    };
  },
};

export default weatherOverlayLayer;
