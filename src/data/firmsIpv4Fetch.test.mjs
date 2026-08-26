import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFetchError } from '../../vite.config.js';

// Issue #68: fetch()'s TypeError only ever says "fetch failed" — the actual
// reason (ETIMEDOUT, ENETUNREACH, ...) lives on error.cause and was being
// dropped from every FIRMS proxy log line.
test('describeFetchError surfaces error.cause when present', () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ENETUNREACH', message: 'connect ENETUNREACH 2001:db8::1:443' };
  assert.equal(describeFetchError(err), 'fetch failed: connect ENETUNREACH 2001:db8::1:443');
});

test('describeFetchError falls back to a bare code when cause has no message', () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ETIMEDOUT' };
  assert.equal(describeFetchError(err), 'fetch failed: ETIMEDOUT');
});

test('describeFetchError falls back to the plain message when there is no cause', () => {
  assert.equal(describeFetchError(new Error('all FIRMS sources failed')), 'all FIRMS sources failed');
});
