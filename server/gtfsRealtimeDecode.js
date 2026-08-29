/**
 * Minimal GTFS-Realtime (GTFS-RT) protobuf decoder — reads only the
 * VehiclePosition fields this app plots, working directly against GTFS-RT's
 * well-known field numbers on the raw protobuf wire format (#70).
 *
 * No protobuf library: the full gtfs-realtime.proto schema has ~15 message
 * types (trip updates, service alerts, occupancy, ...) this app doesn't
 * need. Reading a handful of known field numbers off the wire is a few
 * dozen lines; the standard `gtfs-realtime-bindings` package would pull in
 * ~700KB and a second protobuf runtime (protobufjs) alongside the
 * `@bufbuild/protobuf` this repo already uses for Meshtastic.
 *
 * Field numbers verified against a real, live, public feed — MBTA's
 * VehiclePositions.pb, captured and byte-walked by hand 2026-08-29 — not
 * just the spec:
 *   FeedMessage        { header=1, entity=2 (repeated) }
 *   FeedHeader         { gtfs_realtime_version=1, incrementality=2, timestamp=3 }
 *   FeedEntity         { id=1, vehicle=4 }
 *   VehiclePosition    { trip=1, position=2, current_status=4, timestamp=5, vehicle=8 }
 *   TripDescriptor     { trip_id=1, route_id=5 }
 *   Position           { latitude=1 (float32), longitude=2 (float32), bearing=3, speed=5 }
 *   VehicleDescriptor  { id=1, label=2 }
 * @module server/gtfsRealtimeDecode
 */

/** Read a protobuf varint starting at `pos`. @returns {[bigint, number]} [value, nextPos] */
function readVarint(bytes, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= bytes.length) throw new Error('truncated varint');
    const byte = bytes[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return [result, pos];
}

/**
 * Walk one protobuf message's top-level fields into a `fieldNumber -> values[]`
 * map — repeated fields (like FeedMessage.entity) naturally collect every
 * occurrence; a non-repeated field is just `.get(n)?.[0]`.
 * @param {Uint8Array} bytes
 * @returns {Map<number, Array<bigint|Uint8Array|number>>}
 */
export function readProtobufFields(bytes) {
  const fields = new Map();
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0b111n);
    let value;
    if (wireType === 0) { // varint
      const [v, next] = readVarint(bytes, pos);
      value = v;
      pos = next;
    } else if (wireType === 2) { // length-delimited (string/bytes/submessage)
      const [len, afterLen] = readVarint(bytes, pos);
      const length = Number(len);
      if (afterLen + length > bytes.length) throw new Error('truncated length-delimited field');
      value = bytes.subarray(afterLen, afterLen + length);
      pos = afterLen + length;
    } else if (wireType === 5) { // 32-bit (float)
      if (pos + 4 > bytes.length) throw new Error('truncated 32-bit field');
      value = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getFloat32(0, true);
      pos += 4;
    } else if (wireType === 1) { // 64-bit (double) — read past it; no field this app needs is one
      if (pos + 8 > bytes.length) throw new Error('truncated 64-bit field');
      pos += 8;
      continue;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

const textDecoder = new TextDecoder();
/** @param {Uint8Array|undefined} bytes @returns {string|null} */
function utf8(bytes) {
  return bytes ? textDecoder.decode(bytes) : null;
}

/**
 * Decode a GTFS-RT FeedMessage (protobuf bytes) into the vehicle positions
 * this app plots. Malformed entities are skipped individually — one bad
 * FeedEntity must not drop every other vehicle in the feed.
 * @param {Uint8Array} bytes
 * @returns {{timestamp: number|null, vehicles: Array<{id:string,label:string|null,tripId:string|null,routeId:string|null,lat:number,lon:number,bearingDeg:number|null,speedMps:number|null,currentStatus:number|null,timestamp:number|null}>}}
 */
export function decodeGtfsRealtimeFeed(bytes) {
  const top = readProtobufFields(bytes);
  const header = top.get(1)?.[0] ? readProtobufFields(top.get(1)[0]) : null;
  const headerTimestamp = header?.get(3)?.[0];
  const timestamp = headerTimestamp != null ? Number(headerTimestamp) * 1000 : null;

  const vehicles = [];
  for (const entityBytes of top.get(2) || []) {
    try {
      const entity = readProtobufFields(entityBytes);
      const vehicleBytes = entity.get(4)?.[0];
      if (!vehicleBytes) continue; // trip_update or alert entity, not a vehicle position
      const vp = readProtobufFields(vehicleBytes);
      const positionBytes = vp.get(2)?.[0];
      if (!positionBytes) continue; // no position, nothing to plot
      const position = readProtobufFields(positionBytes);
      const lat = position.get(1)?.[0];
      const lon = position.get(2)?.[0];
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;

      const trip = vp.get(1)?.[0] ? readProtobufFields(vp.get(1)[0]) : null;
      const vehicleDesc = vp.get(8)?.[0] ? readProtobufFields(vp.get(8)[0]) : null;
      const vehicleId = utf8(vehicleDesc?.get(1)?.[0]) || utf8(entity.get(1)?.[0]);
      if (!vehicleId) continue;

      const bearing = position.get(3)?.[0];
      const speed = position.get(5)?.[0];
      const currentStatus = vp.get(4)?.[0];
      const vpTimestamp = vp.get(5)?.[0];
      vehicles.push({
        id: vehicleId,
        label: utf8(vehicleDesc?.get(2)?.[0]),
        tripId: utf8(trip?.get(1)?.[0]),
        routeId: utf8(trip?.get(5)?.[0]),
        lat,
        lon,
        bearingDeg: typeof bearing === 'number' ? bearing : null,
        speedMps: typeof speed === 'number' ? speed : null,
        currentStatus: currentStatus != null ? Number(currentStatus) : null,
        timestamp: vpTimestamp != null ? Number(vpTimestamp) * 1000 : null,
      });
    } catch {
      continue;
    }
  }
  return { timestamp, vehicles };
}
