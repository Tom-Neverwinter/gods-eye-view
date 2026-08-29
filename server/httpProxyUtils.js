/**
 * Generic upstream-response helpers shared by the dev-server API proxies
 * (rocket launches, overpass, route, adsb.lol, GBFS, military installation,
 * regional brief, weather effects, radio browser, cctv media, ...).
 * Extracted out of vite.config.js (#41).
 * @module server/httpProxyUtils
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * Issue a GET pinned to pre-resolved addresses — http or https, whichever the
 * URL calls for (the radio proxy only ever needs https; CCTV sources can be
 * either). A DNS answer that changes between the resolve check and this
 * connect can't redirect the request, because the connection itself is
 * forced to `addresses`, never a fresh lookup.
 * @param {URL} url
 * @param {{headers?: object, signal?: AbortSignal}} options
 * @param {Array<{address:string,family?:number}>} addresses
 * @returns {Promise<Response>}
 */
export function fetchPinnedGet(url, { headers, signal } = {}, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(url, {
      method: 'GET',
      headers,
      signal,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, String(value));
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        headers: responseHeaders,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}

/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}
