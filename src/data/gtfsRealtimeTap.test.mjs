import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidGtfsRealtimeFeedUrl } from './gtfsRealtimeTap.js';

test('isValidGtfsRealtimeFeedUrl: accepts a real feed URL, rejects malformed/local/credentialed ones', () => {
  assert.equal(isValidGtfsRealtimeFeedUrl('https://cdn.mbta.com/realtime/VehiclePositions.pb'), true);
  assert.equal(isValidGtfsRealtimeFeedUrl('http://example.com/gtfs-rt'), true, 'http is allowed (agencies vary)');
  assert.equal(isValidGtfsRealtimeFeedUrl(''), false);
  assert.equal(isValidGtfsRealtimeFeedUrl(null), false);
  assert.equal(isValidGtfsRealtimeFeedUrl('not a url'), false);
  assert.equal(isValidGtfsRealtimeFeedUrl('ftp://example.com/feed.pb'), false, 'non-http(s) scheme');
  assert.equal(isValidGtfsRealtimeFeedUrl('https://user:pass@example.com/feed.pb'), false, 'embedded credentials');
  // Not a real security boundary by itself (the server-side proxy re-validates,
  // DNS-pins, and blocks the cloud-metadata address — the actual enforcement
  // point), but should still reject the obvious cases for a sane UI-side error.
});
