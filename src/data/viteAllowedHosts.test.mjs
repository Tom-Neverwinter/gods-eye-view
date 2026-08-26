import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvOrJsonEnv } from '../../vite.config.js';

// vite.config.js's server.allowedHosts is `parseCsvOrJsonEnv('ALLOWED_HOSTS', [...])`.
// Issue #21: a LAN bind (HOST=0.0.0.0) must NOT fall back to `allowedHosts: true` —
// this process brokers API keys, so accepting any Host header on a network-exposed
// bind is a DNS-rebinding hole. This pins the helper's behavior with ALLOWED_HOSTS
// unset (the common case) and set, independent of HOST.
test('ALLOWED_HOSTS falls back to the localhost allowlist, never `true`, when unset', () => {
  delete process.env.ALLOWED_HOSTS;
  const fallback = ['localhost', '127.0.0.1', '.local'];
  const result = parseCsvOrJsonEnv('ALLOWED_HOSTS', fallback);
  assert.deepEqual(result, fallback);
  assert.notEqual(result, true);
});

test('ALLOWED_HOSTS honors an operator-supplied comma-separated list', () => {
  process.env.ALLOWED_HOSTS = 'my-laptop.local, other.local';
  try {
    assert.deepEqual(
      parseCsvOrJsonEnv('ALLOWED_HOSTS', ['localhost']),
      ['my-laptop.local', 'other.local'],
    );
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});
