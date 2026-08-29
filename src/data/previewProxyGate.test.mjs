import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installOnPreviewIfEnabled } from '../../server/previewGate.js';

// Issue #22: `vite preview` serves the production build and is easy to
// mistake for a harmless static preview, but it wires up the same key-broker
// middleware as `vite dev` unless explicitly opted out of. This pins the
// fail-closed default and the explicit opt-in.
test('preview does not install key-broker routes by default', () => {
  delete process.env.GEV_PREVIEW_API_PROXIES;
  let installed = false;
  installOnPreviewIfEnabled({ middlewares: {} }, () => { installed = true; });
  assert.equal(installed, false);
});

test('preview installs routes when explicitly opted in', () => {
  process.env.GEV_PREVIEW_API_PROXIES = '1';
  try {
    const middlewares = {};
    let received = null;
    installOnPreviewIfEnabled({ middlewares }, (mw) => { received = mw; });
    assert.equal(received, middlewares);
  } finally {
    delete process.env.GEV_PREVIEW_API_PROXIES;
  }
});
