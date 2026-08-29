import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGtfsRealtimeFeed, readProtobufFields } from './gtfsRealtimeDecode.js';

/** Build a length-delimited (wire type 2) field: tag byte + varint length + payload. */
function field2(fieldNumber, payloadBytes) {
  const tag = (fieldNumber << 3) | 2;
  const len = payloadBytes.length;
  // Payloads in this test file are always < 128 bytes, so a one-byte varint length is enough.
  return Uint8Array.from([tag, len, ...payloadBytes]);
}

function utf8Bytes(str) {
  return Uint8Array.from(Buffer.from(str, 'utf8'));
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

test('readProtobufFields: round-trips a hand-built message (varint + string + nested)', () => {
  // field 1: varint 42, field 2: string "hi", field 3: nested { field 1: string "x" }
  const nested = field2(3, field2(1, utf8Bytes('x')));
  const bytes = concat(Uint8Array.from([(1 << 3) | 0, 42]), field2(2, utf8Bytes('hi')), nested);
  const fields = readProtobufFields(bytes);
  assert.equal(fields.get(1)[0], 42n);
  assert.equal(Buffer.from(fields.get(2)[0]).toString('utf8'), 'hi');
  const innerFields = readProtobufFields(fields.get(3)[0]);
  assert.equal(Buffer.from(innerFields.get(1)[0]).toString('utf8'), 'x');
});

test('decodeGtfsRealtimeFeed: a real captured FeedEntity (MBTA VehiclePositions.pb, 2026-08-29)', () => {
  // Framed bytes of one real vehicle-position entity, byte-walked out of a
  // live fetch of https://cdn.mbta.com/realtime/VehiclePositions.pb — not
  // hand-constructed, so this pins the decoder against real wire bytes, not
  // just this file's own encoder.
  const realEntityHex = '124f0a06796e6b32333022450a200a0b424c2d34303737303939322a0f53687574746c652d47656e657269632001420d0a06796e6b3233301203323330120a0da6ce28421563218ec2200228d39dcbd406';
  const feedMessage = Uint8Array.from(Buffer.from(realEntityHex, 'hex')); // field 2 (entity) is the whole message here — no header
  const decoded = decodeGtfsRealtimeFeed(feedMessage);
  assert.equal(decoded.vehicles.length, 1);
  const v = decoded.vehicles[0];
  assert.equal(v.id, 'ynk230');
  assert.equal(v.label, '230');
  assert.equal(v.tripId, 'BL-40770992');
  assert.equal(v.routeId, 'Shuttle-Generic');
  assert.ok(Math.abs(v.lat - 42.2018) < 0.001);
  assert.ok(Math.abs(v.lon - (-71.0652)) < 0.001);
  assert.equal(v.bearingDeg, null, 'this real entity carries no bearing');
  assert.equal(v.currentStatus, 2);
  assert.equal(v.timestamp, 1788006099000);
});

test('decodeGtfsRealtimeFeed: header timestamp is read and converted to epoch ms', () => {
  // FeedHeader { timestamp = field 3 } wrapped as FeedMessage field 1.
  const headerBytes = Uint8Array.from([(3 << 3) | 0, ...encodeVarint(1700000000n)]);
  const feedMessage = field2(1, headerBytes);
  const decoded = decodeGtfsRealtimeFeed(feedMessage);
  assert.equal(decoded.timestamp, 1700000000000);
  assert.deepEqual(decoded.vehicles, []);
});

function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) bytes.push(byte | 0x80);
    else { bytes.push(byte); break; }
  }
  return bytes;
}

test('decodeGtfsRealtimeFeed: entities with no vehicle, or a vehicle with no position, are skipped', () => {
  // entity 1: id only, no vehicle field at all (e.g. a trip_update entity)
  const entityNoVehicle = field2(1, utf8Bytes('e1'));
  // entity 2: has a vehicle, but that VehiclePosition carries no position field
  const vehicleNoPosition = field2(1, utf8Bytes('e2')); // trip only, no position
  const entityWithEmptyVehicle = concat(field2(1, utf8Bytes('e2')), field2(4, vehicleNoPosition));
  const feedMessage = concat(field2(2, entityNoVehicle), field2(2, entityWithEmptyVehicle));
  const decoded = decodeGtfsRealtimeFeed(feedMessage);
  assert.deepEqual(decoded.vehicles, []);
});

test('decodeGtfsRealtimeFeed: a malformed entity is skipped, not fatal to the rest of the feed', () => {
  const truncatedGarbage = Uint8Array.from([0xff, 0xff, 0xff]); // an invalid length-delimited field
  const malformedEntity = field2(2, truncatedGarbage);
  const goodEntity = field2(2, concat(
    field2(1, utf8Bytes('good')),
    field2(4, concat(
      field2(2, concat(
        Uint8Array.from([(1 << 3) | 5, ...new Uint8Array(new Float32Array([10]).buffer)]),
        Uint8Array.from([(2 << 3) | 5, ...new Uint8Array(new Float32Array([20]).buffer)]),
      )),
    )),
  ));
  const decoded = decodeGtfsRealtimeFeed(concat(malformedEntity, goodEntity));
  assert.equal(decoded.vehicles.length, 1);
  assert.equal(decoded.vehicles[0].id, 'good');
  assert.equal(decoded.vehicles[0].lat, 10);
  assert.equal(decoded.vehicles[0].lon, 20);
});

test('decodeGtfsRealtimeFeed: empty feed decodes to zero vehicles, never throws', () => {
  assert.deepEqual(decodeGtfsRealtimeFeed(new Uint8Array(0)), { timestamp: null, vehicles: [] });
});
