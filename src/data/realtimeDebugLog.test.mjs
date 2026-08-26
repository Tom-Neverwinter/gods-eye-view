import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactRealtimeDebugValue, REALTIME_DEBUG_LOG_EVENT_RE } from '../../vite.config.js';

// Issue #24: /api/realtime/debug-log must not trust the client's own
// redaction — a direct POST bypasses gevRealtime.js entirely. This pins the
// server-side mirror (redactRealtimeDebugValue) against the same secret
// shapes the client-side sanitizer strips.
test('redacts secret-like keys regardless of nesting', () => {
  const out = redactRealtimeDebugValue({
    apiKey: 'sk-proj-should-not-matter',
    nested: { authorization: 'Bearer abc', ok: 'fine' },
  });
  assert.equal(out.apiKey, '[Redacted]');
  assert.equal(out.nested.authorization, '[Redacted]');
  assert.equal(out.nested.ok, 'fine');
});

test('redacts inline secrets found inside plain strings', () => {
  const out = redactRealtimeDebugValue({
    note: 'token was sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  });
  assert.match(out.note, /\[Redacted OpenAI API key]/);
});

test('redacts data: image URLs instead of storing them raw', () => {
  const out = redactRealtimeDebugValue('data:image/png;base64,AAAA');
  assert.match(out, /^\[Redacted image data URL/);
});

test('event-name schema accepts dotted identifiers, rejects free text', () => {
  assert.ok(REALTIME_DEBUG_LOG_EVENT_RE.test('tool.call.skipped_superseded'));
  assert.ok(!REALTIME_DEBUG_LOG_EVENT_RE.test('anything I want to write here'));
  assert.ok(!REALTIME_DEBUG_LOG_EVENT_RE.test(''));
});
