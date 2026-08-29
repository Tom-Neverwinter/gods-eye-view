import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRtlsdrAltitude,
  isValidRtlsdrBase,
  normalizeRtlsdrAircraft,
  parseRtlsdrAircraftJson,
} from './rtlsdrTap.js';

test('isValidRtlsdrBase: accepts host:port, rejects malformed targets', () => {
  assert.equal(isValidRtlsdrBase('localhost:8080'), true);
  assert.equal(isValidRtlsdrBase('192.168.1.50:8080'), true);
  assert.equal(isValidRtlsdrBase('my-pi.local:80'), true);
  assert.equal(isValidRtlsdrBase('localhost'), false, 'missing port');
  assert.equal(isValidRtlsdrBase('localhost:0'), false, 'port out of range');
  assert.equal(isValidRtlsdrBase('localhost:70000'), false, 'port out of range');
  assert.equal(isValidRtlsdrBase(''), false);
  assert.equal(isValidRtlsdrBase(null), false);
  assert.equal(isValidRtlsdrBase('localhost:8080/../etc'), false);
});

test('normalizeRtlsdrAircraft: real dump1090-fa row shape, airborne with a fresh position', () => {
  const ac = normalizeRtlsdrAircraft({
    hex: 'A1B2C3',
    flight: 'UAL123  ',
    lat: 40.123,
    lon: -73.456,
    alt_baro: 35000,
    gs: 450.5,
    track: 270.3,
    squawk: '1200',
    seen: 0.2,
    seen_pos: 0.5,
  });
  assert.deepEqual(ac, {
    id: 'a1b2c3',
    flight: 'UAL123',
    lat: 40.123,
    lon: -73.456,
    altBaroFt: 35000,
    groundSpeedKt: 450.5,
    trackDeg: 270.3,
    squawk: '1200',
    seenPosSec: 0.5,
  });
});

test('normalizeRtlsdrAircraft: "ground" is a real alt_baro value, not a parse failure', () => {
  const ac = normalizeRtlsdrAircraft({ hex: 'abc123', lat: 1, lon: 2, alt_baro: 'ground' });
  assert.equal(ac.altBaroFt, 'ground');
});

test('normalizeRtlsdrAircraft: no position yet (Mode S only, no ADS-B fix) is dropped', () => {
  assert.equal(normalizeRtlsdrAircraft({ hex: 'abc123', alt_baro: 10000 }), null);
  assert.equal(normalizeRtlsdrAircraft({ hex: 'abc123', lat: 1 }), null, 'lon missing');
});

test('normalizeRtlsdrAircraft: a stale position (seen_pos past the freshness window) is dropped', () => {
  assert.equal(
    normalizeRtlsdrAircraft({ hex: 'abc123', lat: 1, lon: 2, seen_pos: 61 }),
    null,
    'a position last updated over a minute ago must not be plotted as current',
  );
  assert.ok(normalizeRtlsdrAircraft({ hex: 'abc123', lat: 1, lon: 2, seen_pos: 59 }));
});

test('normalizeRtlsdrAircraft: out-of-range or missing hex is rejected, never throws', () => {
  assert.equal(normalizeRtlsdrAircraft({ hex: '', lat: 1, lon: 2 }), null);
  assert.equal(normalizeRtlsdrAircraft({ lat: 91, lon: 2, hex: 'a' }), null, 'lat out of range');
  assert.equal(normalizeRtlsdrAircraft(null), null);
});

test('parseRtlsdrAircraftJson: real aircraft.json shape — filters unpositioned rows, keeps the rest', () => {
  const body = {
    now: 1700000000.0,
    messages: 123456,
    aircraft: [
      { hex: 'a1', flight: 'AAL1', lat: 10, lon: 20, alt_baro: 30000 },
      { hex: 'a2', alt_baro: 5000 }, // no position yet — dropped
      { hex: 'a3', lat: 11, lon: 21, alt_baro: 'ground' },
    ],
  };
  const parsed = parseRtlsdrAircraftJson(body);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((ac) => ac.id), ['a1', 'a3']);
});

test('parseRtlsdrAircraftJson: malformed/empty input yields no aircraft, never throws', () => {
  assert.deepEqual(parseRtlsdrAircraftJson(null), []);
  assert.deepEqual(parseRtlsdrAircraftJson({}), []);
  assert.deepEqual(parseRtlsdrAircraftJson({ aircraft: 'not an array' }), []);
});

test('formatRtlsdrAltitude: GND on the ground, formatted feet in the air, dash otherwise', () => {
  assert.equal(formatRtlsdrAltitude('ground'), 'GND');
  assert.equal(formatRtlsdrAltitude(12345), '12,345 ft');
  assert.equal(formatRtlsdrAltitude(null), '—');
  assert.equal(formatRtlsdrAltitude(NaN), '—');
});
