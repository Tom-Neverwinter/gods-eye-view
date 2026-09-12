// src/data/alprCameras.test.mjs
// Focused tests for the pure helpers — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alprRetryDelayMs,
  boxKey,
  destinationPointDeg,
  isFlockOperated,
  normalizeAlprNode,
  quantizeBox,
} from './alprCameras.js';

test('isFlockOperated: matches on operator or manufacturer, case-insensitively', () => {
  assert.equal(isFlockOperated({ operator: 'Flock Safety' }), true);
  assert.equal(isFlockOperated({ manufacturer: 'flock safety inc' }), true);
  assert.equal(isFlockOperated({ operator: 'City of Springfield PD' }), false);
  assert.equal(isFlockOperated({}), false);
  assert.equal(isFlockOperated(undefined), false);
});

test('normalizeAlprNode: maps a full OSM node to a plain record', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 12345,
    lat: 30.2672,
    lon: -97.7431,
    tags: {
      man_made: 'surveillance',
      'surveillance:type': 'ALPR',
      operator: 'Flock Safety',
      'camera:type': 'fixed',
      'surveillance:zone': 'traffic',
      'camera:direction': '270',
      ref: 'ATX-001',
      check_date: '2026-06-01',
    },
  });
  assert.deepEqual(record, {
    id: 'alpr:12345',
    osmId: 12345,
    latitude: 30.2672,
    longitude: -97.7431,
    flock: true,
    operator: 'Flock Safety',
    manufacturer: null,
    cameraType: 'fixed',
    zone: 'traffic',
    directionDeg: 270,
    ref: 'ATX-001',
    lastVerified: '2026-06-01',
    source: null,
  });
});

test('normalizeAlprNode: rejects non-node elements and missing coordinates', () => {
  assert.equal(normalizeAlprNode(null), null);
  assert.equal(normalizeAlprNode({ type: 'way', id: 1, tags: {} }), null);
  assert.equal(normalizeAlprNode({ type: 'node', id: 1, lat: NaN, lon: 1, tags: {} }), null);
});

test('normalizeAlprNode: a present-but-blank direction tag reads as missing, not zero', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 1,
    lat: 30,
    lon: -97,
    tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'camera:direction': '' },
  });
  assert.equal(record.directionDeg, null);
});

test('destinationPointDeg: due-north offset increases latitude, keeps longitude', () => {
  const dest = destinationPointDeg(30, -97, 0, 100);
  assert.ok(dest.latitude > 30);
  assert.ok(Math.abs(dest.longitude - -97) < 1e-6);
});

test('alprRetryDelayMs: doubles from a 30s floor to a 240s ceiling', () => {
  assert.equal(alprRetryDelayMs(0), 30000);
  assert.equal(alprRetryDelayMs(30000), 60000);
  assert.equal(alprRetryDelayMs(200000), 240000);
  assert.equal(alprRetryDelayMs(240000), 240000);
});

test('quantizeBox: snaps outward so the fetch box always contains the viewport', () => {
  const view = { south: 30.21, west: -97.83, north: 30.34, east: -97.66 };
  const snapped = quantizeBox(view);
  assert.ok(snapped.south <= view.south, 'south floors outward');
  assert.ok(snapped.west <= view.west, 'west floors outward');
  assert.ok(snapped.north >= view.north, 'north ceils outward');
  assert.ok(snapped.east >= view.east, 'east ceils outward');
  // Every edge lands on the 0.125 grid. Tested as an exact integer multiple
  // rather than `% 0.125 === 0`, which yields -0 on negative edges.
  for (const edge of [snapped.south, snapped.west, snapped.north, snapped.east]) {
    assert.ok(Number.isInteger(edge / 0.125), `${edge} is on the grid`);
  }
});

test('quantizeBox: panning within one cell yields the identical box, so the fetch is reused', () => {
  const a = quantizeBox({ south: 30.21, west: -97.83, north: 30.34, east: -97.66 });
  const b = quantizeBox({ south: 30.22, west: -97.82, north: 30.35, east: -97.65 });
  assert.equal(boxKey(a), boxKey(b), 'a small pan stays in the same cell');

  const far = quantizeBox({ south: 31.21, west: -96.83, north: 31.34, east: -96.66 });
  assert.notEqual(boxKey(a), boxKey(far), 'a real move produces a new cell');
});

test('quantizeBox: never widens past the poles or the antimeridian', () => {
  const snapped = quantizeBox({ south: -89.99, west: -179.99, north: 89.99, east: 179.99 });
  assert.equal(snapped.south, -90);
  assert.equal(snapped.west, -180);
  assert.equal(snapped.north, 90);
  assert.equal(snapped.east, 180);
});

test('quantizeBox: rejects a non-finite or missing box rather than fetching NaN', () => {
  assert.equal(quantizeBox(null), null);
  assert.equal(quantizeBox({ south: NaN, west: 0, north: 1, east: 1 }), null);
  assert.equal(boxKey(null), '');
});
