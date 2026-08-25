// src/data/alprCameras.test.mjs
// Focused tests for the pure helpers — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alprRetryDelayMs,
  destinationPointDeg,
  isFlockOperated,
  normalizeAlprNode,
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
