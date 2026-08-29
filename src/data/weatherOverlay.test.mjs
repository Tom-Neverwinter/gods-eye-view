import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEATHER_OVERLAYS,
  applyWeatherOverlayParams,
  buildOverlayUrlTemplate,
  parseWeatherMapsResponse,
  pickLatestFrame,
  weatherOverlayHiddenReason,
} from './weatherOverlay.js';

test('WEATHER_OVERLAYS: exactly the two shipped overlays, each with a frame path and credit', () => {
  assert.deepEqual(WEATHER_OVERLAYS.map((o) => o.key), ['radar', 'satellite']);
  for (const overlay of WEATHER_OVERLAYS) {
    assert.ok(Array.isArray(overlay.framesPath) && overlay.framesPath.length === 2);
    assert.ok(overlay.credit);
  }
});

test('pickLatestFrame: last (most recent) entry of a chronological frame array, or null', () => {
  assert.equal(pickLatestFrame(undefined), null);
  assert.equal(pickLatestFrame([]), null);
  const frames = [{ time: 100, path: '/a' }, { time: 200, path: '/b' }, { time: 300, path: '/c' }];
  assert.deepEqual(pickLatestFrame(frames), { time: 300, path: '/c' });
});

test('parseWeatherMapsResponse: real shape (2026-08-29 live capture) — radar frame present, satellite empty', () => {
  const live = {
    version: '2.0',
    generated: 1788003935,
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: 1788000000, path: '/v2/radar/c04cdbb85e2b' },
        { time: 1788003600, path: '/v2/radar/e450cabac617' },
      ],
      nowcast: [],
    },
    satellite: { infrared: [] },
  };
  const parsed = parseWeatherMapsResponse(live);
  assert.equal(parsed.host, 'https://tilecache.rainviewer.com');
  assert.equal(parsed.generated, 1788003935 * 1000);
  assert.deepEqual(parsed.frames.radar, { time: 1788003600, path: '/v2/radar/e450cabac617' });
  assert.equal(parsed.frames.satellite, null, 'an empty satellite array degrades to null, not a crash');
});

test('parseWeatherMapsResponse: malformed input (no host) is null, not a throw', () => {
  assert.equal(parseWeatherMapsResponse(null), null);
  assert.equal(parseWeatherMapsResponse({}), null);
  assert.equal(parseWeatherMapsResponse({ radar: {} }), null);
});

test('buildOverlayUrlTemplate: matches the confirmed-live RainViewer tile pattern', () => {
  const url = buildOverlayUrlTemplate(
    'https://tilecache.rainviewer.com',
    { colorScheme: 2, options: '1_1' },
    { path: '/v2/radar/e450cabac617' },
  );
  assert.equal(
    url,
    'https://tilecache.rainviewer.com/v2/radar/e450cabac617/256/{z}/{x}/{y}/2/1_1.png',
  );
  assert.match(url, /\{z\}.*\{x\}.*\{y\}/);
});

test('weatherOverlayHiddenReason: null when disabled, nothing chosen, or the globe is shown', () => {
  assert.equal(weatherOverlayHiddenReason(false, { radar: true, satellite: true }, false), null);
  assert.equal(weatherOverlayHiddenReason(true, { radar: false, satellite: false }, false), null);
  assert.equal(weatherOverlayHiddenReason(true, { radar: true, satellite: false }, true), null);
});

test('weatherOverlayHiddenReason: explains itself when enabled + chosen but the photoreal globe is hidden', () => {
  const reason = weatherOverlayHiddenReason(true, { radar: true, satellite: false }, false);
  assert.ok(reason && /globe/i.test(reason));
});

test('applyWeatherOverlayParams: flips only known keys with boolean values, reports whether anything changed', () => {
  const current = { radar: true, satellite: false };
  const a = applyWeatherOverlayParams(current, { satellite: true });
  assert.deepEqual(a.next, { radar: true, satellite: true });
  assert.equal(a.changed, true);

  const b = applyWeatherOverlayParams(current, { radar: true });
  assert.deepEqual(b.next, current);
  assert.equal(b.changed, false);

  const c = applyWeatherOverlayParams(current, { unknownKey: false, radar: 'nope' });
  assert.deepEqual(c.next, current);
  assert.equal(c.changed, false);
});
