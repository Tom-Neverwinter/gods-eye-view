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
 * @file Public ALPR / Flock Safety camera layer.
 *
 * Data source: OpenStreetMap, tagged by the crowdsourced DeFlock project
 * (`man_made=surveillance` + `surveillance:type=ALPR`) — see
 * https://wiki.openstreetmap.org/wiki/Tag:surveillance:type=ALPR and
 * https://deflock.me. Fetched viewport-bounded through the existing generic
 * `/api/overpass` proxy (same one `traffic.js` and `militaryInstallations.js`
 * use) — no new server route needed for a single narrow tag pair.
 *
 * This is mapped surveillance infrastructure, not a live camera feed: no
 * plate records, no vendor accounts, nothing beyond what a contributor chose
 * to publish to OSM. See issue #5.
 *
 * @module data/alprCameras
 */

const LAYER_ID = 'alpr-cameras';
const OVERPASS_URL = '/api/overpass';
const REQUEST_DEBOUNCE_MS = 500;
/** ALPR nodes are far denser than mapped installations (336K+ worldwide as
 * of 2026), so the viewport allowed before asking the user to zoom in is
 * tighter than militaryInstallations' 10°. */
const MAX_VIEWPORT_DEGREES = 3;
/** Overpass `out body N;` cap — also used to detect a truncated (saturated) response. */
const QUERY_LIMIT = 600;
const MAX_RENDERED = 500;
/** Meters — length of the facing-direction indicator line, when a camera reports one. */
const DIRECTION_CONE_M = 25;
const EARTH_MEAN_RADIUS_M = 6371008.8;
const FLOCK_COLOR = '#ff5a5a';
const OTHER_ALPR_COLOR = '#5ab0ff';

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  stale: false,
  /** Whether the query hit QUERY_LIMIT — the view likely holds more cameras than shown. */
  saturated: false,
  loading: false,
  abort: null,
  retryTimer: null,
  retryDelayMs: 0,
  moveEndRemove: null,
  clickHandler: null,
};

function textTag(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

function numTag(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Flock Safety cameras get their own color; every other tagged ALPR shares another. */
export function isFlockOperated(tags) {
  const operator = String(tags?.operator || '').toLowerCase();
  const manufacturer = String(tags?.manufacturer || '').toLowerCase();
  return operator.includes('flock') || manufacturer.includes('flock');
}

function colorFor(record) {
  return Cesium.Color.fromCssColorString(record.flock ? FLOCK_COLOR : OTHER_ALPR_COLOR);
}

/**
 * Great-circle destination point — used only to draw the short
 * facing-direction line when a node carries `camera:direction`/`direction`.
 * @param {number} latDeg @param {number} lonDeg
 * @param {number} bearingDeg Compass bearing, degrees clockwise from north.
 * @param {number} distanceM
 * @returns {{latitude:number, longitude:number}}
 */
export function destinationPointDeg(latDeg, lonDeg, bearingDeg, distanceM) {
  const angularDistance = distanceM / EARTH_MEAN_RADIUS_M;
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const lat1 = Cesium.Math.toRadians(latDeg);
  const lon1 = Cesium.Math.toRadians(lonDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
    + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { latitude: Cesium.Math.toDegrees(lat2), longitude: Cesium.Math.toDegrees(lon2) };
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function alprRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/** Map one raw Overpass node element to a plain camera record. Null for anything unusable. */
export function normalizeAlprNode(el) {
  if (!el || el.type !== 'node' || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) return null;
  const tags = el.tags || {};
  return {
    id: `alpr:${el.id}`,
    osmId: el.id,
    latitude: el.lat,
    longitude: el.lon,
    flock: isFlockOperated(tags),
    operator: textTag(tags.operator),
    manufacturer: textTag(tags.manufacturer),
    cameraType: textTag(tags['camera:type']),
    zone: textTag(tags['surveillance:zone']),
    // ponytail: only numeric bearings are parsed; compass-word directions
    // ("N"/"NE") are rare on this tag and just render with no cone.
    directionDeg: numTag(tags['camera:direction'] ?? tags.direction),
    ref: textTag(tags.ref),
    lastVerified: textTag(tags.check_date) || textTag(tags['survey:date']),
    source: textTag(tags.source),
  };
}

function buildOverpassQuery(south, west, north, east) {
  return `[out:json][timeout:20];node["man_made"="surveillance"]["surveillance:type"="ALPR"]`
    + `(${south},${west},${north},${east});out body ${QUERY_LIMIT};`;
}

async function fetchAlprNodes(box, signal) {
  const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!response.ok) throw new Error(`Overpass API returned ${response.status}`);
  const stale = response.headers.get('x-overpass-cache') === 'STALE';
  const payload = await response.json();
  return { elements: Array.isArray(payload?.elements) ? payload.elements : [], stale };
}

function setAlprStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('alpr-status');
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (!Number.isFinite(south + north + west + east) || east <= west
    || north - south > MAX_VIEWPORT_DEGREES || east - west > MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

function renderRecords() {
  governorRequestRender('alpr-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const color = colorFor(record);
    const selected = record.id === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const entityDef = {
      id: record.id,
      position,
      point: {
        pixelSize: selected ? 12 : 8,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
    if (Number.isFinite(record.directionDeg)) {
      const tip = destinationPointDeg(record.latitude, record.longitude, record.directionDeg, DIRECTION_CONE_M);
      entityDef.polyline = {
        positions: [position, Cesium.Cartesian3.fromDegrees(tip.longitude, tip.latitude)],
        width: 2,
        material: color.withAlpha(0.85),
        clampToGround: true,
      };
    }
    const entity = state.dataSource.entities.add(entityDef);
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.flock ? 'FLOCK SAFETY ALPR' : 'ALPR CAMERA',
      details: [record.operator, record.zone ? record.zone.toUpperCase() : null].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'ALPR / Flock Cameras',
      source: record.source || 'OpenStreetMap contributors / DeFlock (crowdsourced)',
      label: record.flock ? 'Flock Safety ALPR camera' : 'ALPR camera',
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        operator: record.operator,
        manufacturer: record.manufacturer,
        cameraType: record.cameraType,
        zone: record.zone,
        directionDeg: record.directionDeg,
        ref: record.ref,
        lastVerified: record.lastVerified,
        osmId: record.osmId,
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectRecord(id) {
  if (!state.recordById.has(id) || !state.dataSource) return false;
  state.selectedId = id;
  renderRecords();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.recordById.has(id)) selectRecord(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = alprRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadCameras();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => { loadCameras(); }, REQUEST_DEBOUNCE_MS);
}

async function loadCameras() {
  if (!state.enabled || !state.viewer) return;
  const box = viewportBox(state.viewer);
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    setAlprStatus('zoom-in', 'Zoom in to load mapped ALPR camera locations');
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.loading = true;
  try {
    const { elements, stale } = await fetchAlprNodes(box, requestAbort.signal);
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    const records = elements.map(normalizeAlprNode).filter(Boolean);
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    state.lastUpdate = Date.now();
    state.stale = stale;
    state.saturated = elements.length >= QUERY_LIMIT;
    clearUnavailableRetry();
    setAlprStatus(
      records.length ? (stale ? 'stale' : 'ready') : 'empty',
      stale
        ? 'Serving cached ALPR camera locations'
        : (state.saturated ? 'Too many mapped cameras in view to list them all — zoom in' : null),
    );
    renderRecords();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setAlprStatus('unavailable', error?.message || 'ALPR camera feed unavailable');
    scheduleUnavailableRetry();
  } finally {
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const alprCamerasLayer = {
  id: LAYER_ID,
  name: 'ALPR / Flock Cameras',
  icon: '📷',
  source: 'OpenStreetMap / DeFlock (Overpass)',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('alpr-cameras');
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
    state.dataSource.show = true;
    // DataLayerManager calls update() right after enable(); it owns the first fetch.
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearUnavailableRetry();
    clearTimeout(state.debounceTimer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadCameras(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.records = [];
    state.recordById = new Map();
    state.lastUpdate = null;
    state.error = null;
    state.status = 'idle';
  },
  getStats() {
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      stale: state.stale,
      saturated: state.saturated,
      error: state.error,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading ALPR camera locations' : '',
    };
  },
};

export default alprCamerasLayer;
