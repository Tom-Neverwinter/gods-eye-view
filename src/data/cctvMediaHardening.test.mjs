import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlausiblePublicMediaUrl,
  validatedRangeHeader,
  fetchCctvImageFromUpstream,
} from '../../vite.config.js';

// Issue #29: operator-registered CCTV URLs must reject an obviously-private
// destination at parse time (the post-DNS-resolution pin is the second layer,
// exercised through fetchCctvImageFromUpstream below).
test('isPlausiblePublicMediaUrl accepts a plain public http(s) URL', () => {
  assert.equal(isPlausiblePublicMediaUrl('https://example.com/frame.jpg'), true);
  assert.equal(isPlausiblePublicMediaUrl('http://cameras.example.org/a.jpg'), true);
});

test('isPlausiblePublicMediaUrl rejects localhost, .local, and private/loopback literals', () => {
  assert.equal(isPlausiblePublicMediaUrl('http://localhost/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://camera.local/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://127.0.0.1/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://10.0.0.5/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://192.168.1.1/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://[::1]/x.jpg'), false);
});

test('isPlausiblePublicMediaUrl rejects non-http(s) schemes and embedded credentials', () => {
  assert.equal(isPlausiblePublicMediaUrl('file:///etc/passwd'), false);
  assert.equal(isPlausiblePublicMediaUrl('ftp://example.com/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl('http://user:pass@example.com/x.jpg'), false);
  assert.equal(isPlausiblePublicMediaUrl(''), false);
  assert.equal(isPlausiblePublicMediaUrl('not a url'), false);
});

test('fetchCctvImageFromUpstream rejects a private-address URL before any fetch happens', async () => {
  let fetchCalled = false;
  const result = await fetchCctvImageFromUpstream('http://169.254.169.254/latest/meta-data', {
    fetchImpl: async () => { fetchCalled = true; return new Response(new Uint8Array(), { status: 200 }); },
  });
  assert.equal(result, null);
  assert.equal(fetchCalled, false, 'a rejected URL must never reach the network');
});

test('fetchCctvImageFromUpstream caps the buffered body instead of reading it unbounded', async () => {
  // Issue #28: a declared Content-Length over the cap must short-circuit
  // before any bytes are buffered.
  const oversized = 20 * 1024 * 1024; // over the 16 MB cap
  const result = await fetchCctvImageFromUpstream('https://example.com/huge.jpg', {
    fetchImpl: async () => new Response(new Uint8Array(1), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(oversized) },
    }),
  });
  assert.equal(result, null);
});

// Issue #27: the media proxy must validate/strip the client Range header
// instead of forwarding it verbatim.
test('validatedRangeHeader accepts a single satisfiable byte range', () => {
  assert.equal(validatedRangeHeader('bytes=0-499'), 'bytes=0-499');
  assert.equal(validatedRangeHeader('bytes=500-'), 'bytes=500-');
  assert.equal(validatedRangeHeader('bytes=-500'), 'bytes=-500');
});

test('validatedRangeHeader rejects multi-range, malformed, and absurd offsets', () => {
  assert.equal(validatedRangeHeader('bytes=0-10,20-30'), null, 'multi-range must be refused');
  assert.equal(validatedRangeHeader('items=0-10'), null, 'non-byte unit must be refused');
  assert.equal(validatedRangeHeader('bytes=-'), null, 'empty range must be refused');
  assert.equal(validatedRangeHeader('bytes=500-100'), null, 'inverted range must be refused');
  assert.equal(validatedRangeHeader('bytes=99999999999999-'), null, 'absurd offset must be refused');
  assert.equal(validatedRangeHeader(undefined), null);
  assert.equal(validatedRangeHeader(''), null);
});
