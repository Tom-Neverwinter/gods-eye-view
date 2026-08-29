/**
 * Preview-server opt-in gate for the dev-only API proxies. Extracted out of
 * vite.config.js (#41).
 * @module server/previewGate
 */

/**
 * `vite preview` serves the production BUILD and is easy to mistake for a
 * harmless static preview — but every proxy plugin also wires itself into
 * `configurePreviewServer`, so by default it brokers the exact same
 * server-side secrets (OpenAI, Google, AISStream, WiGLE, OpenSky, TAK mTLS
 * certs) as `vite dev`. Fail closed: preview does NOT get these routes
 * unless explicitly opted into (#22). Dev is unaffected — this only gates
 * the `configurePreviewServer` hook.
 * @param {import('vite').PreviewServer} server
 * @param {(middlewares: import('connect').Server) => void} install
 */
export function installOnPreviewIfEnabled(server, install) {
  if (process.env.GEV_PREVIEW_API_PROXIES !== '1') return;
  install(server.middlewares);
}
