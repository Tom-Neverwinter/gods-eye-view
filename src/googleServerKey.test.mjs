import assert from 'node:assert/strict';
import test from 'node:test';
import { googleServerApiKey } from '../vite.config.js';

/** Run fn with the two Google key env vars set to the given values, then restore. */
function withKeys({ server, browser }, fn) {
  const previous = {
    GOOGLE_MAPS_SERVER_API_KEY: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  };
  const apply = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  apply('GOOGLE_MAPS_SERVER_API_KEY', server);
  apply('GOOGLE_MAPS_API_KEY', browser);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) apply(name, value);
  }
}

test('server-side Google calls prefer the server-only key', () => {
  withKeys({ server: 'server-key', browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'server-key');
  });
});

test('unsplit setups still work: falls back to the browser key', () => {
  // The whole point of #33 being opt-in — one shared GOOGLE_MAPS_API_KEY must
  // keep serving Places/Street View exactly as before.
  withKeys({ server: undefined, browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'browser-key');
  });
  withKeys({ server: '', browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'browser-key');
  });
});

test('keyless stays keyless', () => {
  withKeys({ server: undefined, browser: undefined }, () => {
    assert.ok(!googleServerApiKey());
  });
});
