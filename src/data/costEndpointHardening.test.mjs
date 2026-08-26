import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCostRateLimiter,
  isValidLatLon,
  validRegionalPoint,
  streetViewFallbackParams,
} from '../../vite.config.js';

// Issues #16/#17/#18: the cost-bearing OpenAI/Google endpoints must not be
// unlimited by default — only an explicit 0 opts out.
test('cost rate limiter is default-on when the env var is unset', () => {
  const limiter = makeCostRateLimiter(undefined, 2);
  assert.ok(limiter, 'unset env must not mean unlimited');
  assert.equal(limiter('ip-a'), true);
  assert.equal(limiter('ip-a'), true);
  assert.equal(limiter('ip-a'), false); // 3rd request in the window over a cap of 2
});

test('cost rate limiter honors an explicit 0 as opt-out', () => {
  assert.equal(makeCostRateLimiter('0', 2), null);
});

test('cost rate limiter honors an explicit override count', () => {
  const limiter = makeCostRateLimiter('1', 30);
  assert.equal(limiter('ip-b'), true);
  assert.equal(limiter('ip-b'), false);
});

// Issue #19: coordinates must be validated as real lat/lon ranges, not just finite.
test('isValidLatLon rejects out-of-range values that are still finite numbers', () => {
  assert.equal(isValidLatLon(999, 0), false);
  assert.equal(isValidLatLon(0, -200), false);
  assert.equal(isValidLatLon(NaN, 0), false);
  assert.equal(isValidLatLon(45, -122), true);
  assert.equal(isValidLatLon(-90, 180), true); // inclusive bounds
});

test('validRegionalPoint still rejects the same out-of-range coordinates', () => {
  const params = new URLSearchParams({ latitude: '999', longitude: '0' });
  assert.equal(validRegionalPoint(params), null);
});

// Issue #20: Street View fallback must come from the registered source only,
// and must not be reachable for an unregistered camera id.
test('streetViewFallbackParams returns null for an unregistered camera (no source)', () => {
  assert.equal(streetViewFallbackParams(undefined), null);
});

test('streetViewFallbackParams ignores nothing client-supplied — only source fields', () => {
  const params = streetViewFallbackParams({ lat: 40.7, lon: -74.0, headingDeg: 90, fovDeg: 80, pitchDeg: -10 });
  assert.deepEqual(params, { lat: 40.7, lon: -74.0, heading: 90, fov: 80, pitch: -10 });
});
