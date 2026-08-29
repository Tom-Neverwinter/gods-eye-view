import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, haversineMeters } from './geoMath.js';

test('haversineKm: Austin -> Houston is ~235km', () => {
  const km = haversineKm(30.2672, -97.7431, 29.7604, -95.3698);
  assert.ok(km > 200 && km < 280, `expected ~235km, got ${km}`);
});

test('haversineKm: same point is zero', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
});

test('haversineMeters: agrees with haversineKm x1000', () => {
  const a = [30.2672, -97.7431];
  const b = [29.7604, -95.3698];
  assert.equal(haversineMeters(...a, ...b), haversineKm(...a, ...b) * 1000);
});
