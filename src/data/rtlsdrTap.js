import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * @file RTL-SDR / dump1090 local receiver tap (#57).
 *
 * A user's own dump1090-fa/readsb/tar1090 instance, fed by an RTL-SDR dongle
 * on their desk, runs ON their local network — same "personal device, no
 * CORS headers, same-origin proxy" shape as rayhunterTap.js (#56), polled
 * through `/api/rtlsdr/*` (vite.config.js's rtlsdrTapProxy()).
 *
 * Deliberately separate from flights.js: that layer shows public aggregated
 * ADS-B (one polling interval behind, aggregator coverage, everywhere).
 * This layer shows only aircraft the user's OWN antenna is hearing right
 * now — zero third-party aggregation, useful for judging real receiver
 * range/performance. Off by default, opt-in, like every personal-device tap.
 *
 * aircraft.json shape verified against the real dump1090-fa/readsb/tar1090
 * output format (not guessed): {now, aircraft: [{hex, flight, lat, lon,
 * alt_baro, gs, track, squawk, seen, seen_pos, ...}]}. `alt_baro` can be the
 * literal string "ground" instead of a number; many entries carry no lat/lon
 * at all (heard on Mode S but not yet positioned) or a STALE position dump1090
 * keeps around after the aircraft stopped transmitting it — both handled below.
 * @module data/rtlsdrTap
 */

export const RTLSDR_TAP_LAYER_ID = 'rtlsdr-tap';
const POLL_INTERVAL_MS = 5_000;
const MAX_RENDERED = 500;
// An aircraft.json row can carry a position dump1090 is still reporting from
// several minutes ago if the aircraft stopped transmitting ADS-B position
// messages (Mode S only) without leaving the list. `seen_pos` is time since
// that position was last actually updated — stale past this, don't plot it.
const MAX_POSITION_AGE_SEC = 60;
const BASE_RE = /^[a-zA-Z0-9.-]{1,253}:([0-9]{1,5})$/;
const MARKER_COLOR = '#4dd2ff';

/** Same host:port shape the server-side proxy enforces (vite.config.js) — kept
 * in sync by hand across that trust boundary; duplicating one regex is
 * cheaper than sharing a module across the Node/browser split. */
export function isValidRtlsdrBase(raw) {
  const match = BASE_RE.exec(String(raw || '').trim());
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/**
 * Normalize one raw aircraft.json row into a plain record, or null if it
 * has no usable — and fresh enough — position to plot.
 * @param {object} raw
 * @returns {{id:string,flight:string|null,lat:number,lon:number,altBaroFt:number|'ground'|null,groundSpeedKt:number|null,trackDeg:number|null,squawk:string|null,seenPosSec:number|null}|null}
 */
export function normalizeRtlsdrAircraft(raw) {
  const hex = String(raw?.hex ?? '').trim().toLowerCase();
  if (!hex) return null;
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const seenPosSec = Number(raw?.seen_pos);
  if (Number.isFinite(seenPosSec) && seenPosSec > MAX_POSITION_AGE_SEC) return null; // stale, drop it
  const altBaro = raw?.alt_baro === 'ground' ? 'ground' : Number(raw?.alt_baro);
  const flight = String(raw?.flight ?? '').trim();
  return {
    id: hex,
    flight: flight || null,
    lat,
    lon,
    altBaroFt: altBaro === 'ground' ? 'ground' : (Number.isFinite(altBaro) ? altBaro : null),
    groundSpeedKt: Number.isFinite(Number(raw?.gs)) ? Number(raw.gs) : null,
    trackDeg: Number.isFinite(Number(raw?.track)) ? Number(raw.track) : null,
    squawk: String(raw?.squawk ?? '').trim() || null,
    seenPosSec: Number.isFinite(seenPosSec) ? seenPosSec : null,
  };
}

/**
 * Parse a full aircraft.json body into normalized, plottable records.
 * @param {*} json
 * @returns {Array<object>}
 */
export function parseRtlsdrAircraftJson(json) {
  const rows = Array.isArray(json?.aircraft) ? json.aircraft : [];
  return rows.map(normalizeRtlsdrAircraft).filter(Boolean);
}

/** Human-readable altitude for the label — "GND" on the ground, else "12,345 ft" or "—". */
export function formatRtlsdrAltitude(altBaroFt) {
  if (altBaroFt === 'ground') return 'GND';
  if (!Number.isFinite(altBaroFt)) return '—';
  return `${Math.round(altBaroFt).toLocaleString()} ft`;
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  base: 'localhost:8080',
  aircraft: [], // last poll's normalized rows
  selectedId: null,
  lastUpdate: null,
  error: null,
  abort: null,
  clickHandler: null,
};

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(RTLSDR_TAP_LAYER_ID);
}

// Barometric feet -> ellipsoidal meters, no geoid/MSL correction (ponytail:
// flights.js's real 3D-model pipeline does that properly; this simpler tap
// layer just needs planes to read as airborne vs. on the ground — the
// geoid's ±30-100 m undulation is invisible next to a cruise altitude of
// several thousand meters). Add MSL correction if this layer ever grows
// altitude-accuracy claims of its own.
const FEET_TO_M = 0.3048;

function renderAircraft() {
  governorRequestRender('rtlsdr-render');
  clearRendered();
  const color = Cesium.Color.fromCssColorString(MARKER_COLOR);
  for (const ac of state.aircraft.slice(0, MAX_RENDERED)) {
    const selected = ac.id === state.selectedId;
    const onGround = ac.altBaroFt === 'ground';
    const heightM = onGround || !Number.isFinite(ac.altBaroFt) ? 0 : ac.altBaroFt * FEET_TO_M;
    const position = Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, heightM);
    const entity = state.dataSource.entities.add({
      id: ac.id,
      position,
      point: {
        pixelSize: selected ? 12 : 8,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: onGround || !Number.isFinite(ac.altBaroFt)
          ? Cesium.HeightReference.CLAMP_TO_GROUND
          : Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: ac.flight || ac.id.toUpperCase(),
      details: [formatRtlsdrAltitude(ac.altBaroFt), ac.groundSpeedKt != null ? `${Math.round(ac.groundSpeedKt)} kt` : null].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: ac.id,
      layerId: RTLSDR_TAP_LAYER_ID,
      layerName: 'RTL-SDR Tap',
      source: 'Local dump1090/readsb receiver (personal device, local network)',
      label: ac.flight || ac.id.toUpperCase(),
      latitude: ac.lat,
      longitude: ac.lon,
      properties: {
        icaoHex: ac.id,
        altitude: formatRtlsdrAltitude(ac.altBaroFt),
        groundSpeedKt: ac.groundSpeedKt,
        trackDeg: ac.trackDeg,
        squawk: ac.squawk,
        secondsSincePosition: ac.seenPosSec,
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectAircraft(id) {
  if (!state.aircraft.some((ac) => ac.id === id) || !state.dataSource) return false;
  state.selectedId = id;
  renderAircraft();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.aircraft.some((ac) => ac.id === id)) selectAircraft(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

async function pollReceiver() {
  if (!state.enabled) return;
  if (!isValidRtlsdrBase(state.base)) {
    state.error = 'Invalid receiver address — set it via the ⚙️ chip (host:port)';
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  const stillCurrent = () => !requestAbort.signal.aborted && state.abort === requestAbort && state.enabled;
  try {
    const response = await fetch(
      `/api/rtlsdr/aircraft?base=${encodeURIComponent(state.base)}`,
      { signal: requestAbort.signal },
    );
    if (!stillCurrent()) return;
    if (!response.ok) {
      state.error = response.status === 400
        ? 'Invalid receiver address'
        : 'Receiver unreachable — check dump1090/readsb is running and you’re on its network';
      return;
    }
    const json = await response.json();
    if (!stillCurrent()) return;
    state.aircraft = parseRtlsdrAircraftJson(json);
    state.lastUpdate = Date.now();
    state.error = null;
    renderAircraft();
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    state.error = 'Receiver unreachable — check dump1090/readsb is running and you’re on its network';
  } finally {
    if (state.abort === requestAbort) state.abort = null;
  }
}

const rtlsdrTapLayer = {
  id: RTLSDR_TAP_LAYER_ID,
  name: 'RTL-SDR Tap',
  icon: '📡',
  source: 'Local dump1090/readsb (personal device)',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(RTLSDR_TAP_LAYER_ID);
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(RTLSDR_TAP_LAYER_ID, (id) => state.aircraft.some((ac) => ac.id === id));
    if (state.dataSource) state.dataSource.show = true;
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(RTLSDR_TAP_LAYER_ID);
    state.abort?.abort();
    state.abort = null;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(RTLSDR_TAP_LAYER_ID);
    state.selectedId = null;
  },
  update() { return pollReceiver(); },
  setParams(params = {}) {
    if (Object.hasOwn(params, 'base') && typeof params.base === 'string' && params.base.trim()) {
      state.base = params.base.trim();
    }
    return true;
  },
  getParams() {
    return { base: state.base };
  },
  getRowControls() {
    if (!state.enabled) return { chips: [], legend: [] };
    return {
      chips: [{
        id: 'set-base',
        label: `⚙️ ${state.base}`,
        active: false,
        title: 'Set your dump1090/readsb receiver address (host:port), e.g. localhost:8080',
        prompt: {
          label: 'Receiver address (host:port)',
          value: state.base,
          toParams: (value) => (isValidRtlsdrBase(value) ? { base: value } : null),
        },
      }],
      legend: [],
    };
  },
  destroy(viewer) {
    this.disable();
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.aircraft = [];
    state.lastUpdate = null;
    state.error = null;
  },
  getStats() {
    return {
      count: state.aircraft.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
    };
  },
};

export default rtlsdrTapLayer;
