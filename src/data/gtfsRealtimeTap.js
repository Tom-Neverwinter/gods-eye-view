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
 * @file GTFS-Realtime (GTFS-RT) transit vehicle-position tap (#70).
 *
 * Unlike every other proxy in this app, there is no single fixed or
 * personal-LAN upstream for transit data — every agency runs its own feed at
 * its own URL, and no free keyless API aggregates them (mobilitydatabase.org,
 * named in the issue, is a CATALOG of feed URLs to pick from, not a live
 * data API itself). So this is BYOS (bring your own feed), same shape as the
 * TAK layer's bring-your-own-server: off by default, a ⚙️ chip to paste a
 * feed URL, e.g. from https://mobilitydatabase.org or an agency's own
 * developer page (MBTA's — https://cdn.mbta.com/realtime/VehiclePositions.pb
 * — is public and keyless; verified live 2026-08-29).
 *
 * Deliberately scoped to live VEHICLE POSITIONS, not static route/shape
 * rendering: the issue's literal ask ("populate rail/bus lines") would need
 * parsing a GTFS *static* feed (a zip of routes.txt/shapes.txt/trips.txt —
 * real added scope: zip + CSV + trip-to-shape joins), where GTFS-*Realtime*
 * is a single small protobuf fetch and fits this app's live-tracking pattern
 * (flights, ships, radio, weather, ...) far better than a static line layer
 * would. Static route-shape rendering is real, valuable follow-up work, not
 * done here.
 *
 * Decoding happens server-side (vite.config.js's gtfsRealtimeProxy() +
 * server/gtfsRealtimeDecode.js) — this module only ever sees plain JSON.
 * @module data/gtfsRealtimeTap
 */

export const GTFS_REALTIME_TAP_LAYER_ID = 'gtfs-realtime-tap';
const POLL_INTERVAL_MS = 15_000;
const MAX_RENDERED = 1000;
const MARKER_COLOR = '#ffb84d';
// GTFS-RT VehiclePosition.current_status enum (spec-fixed values, not this
// app's invention): 0 = INCOMING_AT, 1 = STOPPED_AT, 2 = IN_TRANSIT_TO.
const CURRENT_STATUS_LABEL = Object.freeze({ 0: 'incoming', 1: 'stopped', 2: 'in transit' });

/**
 * Same shape check the server-side proxy performs syntactically
 * (isPlausiblePublicMediaUrl in vite.config.js) — kept in sync by hand
 * across that trust boundary, like every sibling tap layer's client-side
 * check. Not a security boundary by itself: the server re-validates (and
 * additionally DNS-pins + blocks the cloud-metadata address) and is the
 * actual enforcement point.
 */
export function isValidGtfsRealtimeFeedUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  feedUrl: '',
  vehicles: [], // last poll's normalized rows
  selectedId: null,
  lastUpdate: null,
  error: null,
  abort: null,
  clickHandler: null,
};

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(GTFS_REALTIME_TAP_LAYER_ID);
}

function renderVehicles() {
  governorRequestRender('gtfs-rt-render');
  clearRendered();
  const color = Cesium.Color.fromCssColorString(MARKER_COLOR);
  for (const v of state.vehicles.slice(0, MAX_RENDERED)) {
    const selected = v.id === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(v.lon, v.lat);
    const entity = state.dataSource.entities.add({
      id: v.id,
      position,
      point: {
        pixelSize: selected ? 12 : 8,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: v.routeId ? `Route ${v.routeId}` : (v.label || v.id),
      details: [CURRENT_STATUS_LABEL[v.currentStatus] || null].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: v.id,
      layerId: GTFS_REALTIME_TAP_LAYER_ID,
      layerName: 'GTFS-Realtime Tap',
      source: 'User-configured GTFS-Realtime feed (BYOS)',
      label: v.routeId ? `Route ${v.routeId}` : (v.label || v.id),
      latitude: v.lat,
      longitude: v.lon,
      properties: {
        vehicleId: v.id,
        vehicleLabel: v.label,
        tripId: v.tripId,
        routeId: v.routeId,
        bearingDeg: v.bearingDeg,
        speedMps: v.speedMps,
        status: CURRENT_STATUS_LABEL[v.currentStatus] || null,
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectVehicle(id) {
  if (!state.vehicles.some((v) => v.id === id) || !state.dataSource) return false;
  state.selectedId = id;
  renderVehicles();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.vehicles.some((v) => v.id === id)) selectVehicle(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

async function pollFeed() {
  if (!state.enabled) return;
  if (!state.feedUrl) {
    state.error = 'No feed configured — set one via the ⚙️ chip (a GTFS-Realtime VehiclePositions URL)';
    return;
  }
  if (!isValidGtfsRealtimeFeedUrl(state.feedUrl)) {
    state.error = 'Invalid feed URL — set it via the ⚙️ chip';
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  const stillCurrent = () => !requestAbort.signal.aborted && state.abort === requestAbort && state.enabled;
  try {
    const response = await fetch(
      `/api/gtfs-rt/vehicle-positions?url=${encodeURIComponent(state.feedUrl)}`,
      { signal: requestAbort.signal },
    );
    if (!stillCurrent()) return;
    if (!response.ok) {
      state.error = response.status === 400
        ? 'Invalid feed URL'
        : 'Feed unreachable — check the URL and that it serves GTFS-Realtime protobuf';
      return;
    }
    const json = await response.json();
    if (!stillCurrent()) return;
    const rows = Array.isArray(json?.vehicles) ? json.vehicles : [];
    state.vehicles = rows.filter((v) => v && typeof v.id === 'string' && Number.isFinite(v.lat) && Number.isFinite(v.lon));
    state.lastUpdate = Number.isFinite(json?.timestamp) ? json.timestamp : Date.now();
    state.error = state.vehicles.length ? null : 'Feed returned no current vehicle positions';
    renderVehicles();
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    state.error = 'Feed unreachable — check the URL and that it serves GTFS-Realtime protobuf';
  } finally {
    if (state.abort === requestAbort) state.abort = null;
  }
}

const gtfsRealtimeTapLayer = {
  id: GTFS_REALTIME_TAP_LAYER_ID,
  name: 'GTFS-Realtime Tap',
  icon: '🚌',
  source: 'User-configured GTFS-Realtime feed (BYOS)',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(GTFS_REALTIME_TAP_LAYER_ID);
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(GTFS_REALTIME_TAP_LAYER_ID, (id) => state.vehicles.some((v) => v.id === id));
    if (state.dataSource) state.dataSource.show = true;
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(GTFS_REALTIME_TAP_LAYER_ID);
    state.abort?.abort();
    state.abort = null;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(GTFS_REALTIME_TAP_LAYER_ID);
    state.selectedId = null;
  },
  update() { return pollFeed(); },
  setParams(params = {}) {
    if (Object.hasOwn(params, 'feedUrl') && typeof params.feedUrl === 'string') {
      state.feedUrl = params.feedUrl.trim();
    }
    return true;
  },
  getParams() {
    return { feedUrl: state.feedUrl };
  },
  getRowControls() {
    if (!state.enabled) return { chips: [], legend: [] };
    return {
      chips: [{
        id: 'set-feed-url',
        label: state.feedUrl ? `⚙️ ${state.feedUrl}` : '⚙️ Set feed URL',
        active: false,
        title: 'Set a GTFS-Realtime VehiclePositions feed URL — find one at mobilitydatabase.org or your transit agency\'s developer page',
        prompt: {
          label: 'GTFS-Realtime feed URL (VehiclePositions)',
          value: state.feedUrl,
          toParams: (value) => (isValidGtfsRealtimeFeedUrl(value) ? { feedUrl: value } : null),
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
    state.vehicles = [];
    state.lastUpdate = null;
    state.error = null;
  },
  getStats() {
    return {
      count: state.vehicles.length,
      lastUpdate: state.lastUpdate,
      error: state.error,
    };
  },
};

export default gtfsRealtimeTapLayer;
