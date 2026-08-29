/**
 * Shared great-circle distance math. Consolidates 7 independent
 * reimplementations (each with its own Earth-radius constant: 6371,
 * 6371.0088, or 6371000) found in a ponytail over-engineering audit.
 * Pure math, no DOM/Node/Cesium dependency — safe to import from both
 * browser (src/) and server (vite.config.js, scripts/) code.
 * @module geoMath
 */

/** IUGG mean Earth radius (km) — the standard reference value for great-circle distance. */
export const EARTH_RADIUS_KM = 6371.0088;

/**
 * Great-circle (haversine) distance between two lat/lon points, in km.
 * @param {number} lat1 - Latitude of point 1 (degrees).
 * @param {number} lon1 - Longitude of point 1 (degrees).
 * @param {number} lat2 - Latitude of point 2 (degrees).
 * @param {number} lon2 - Longitude of point 2 (degrees).
 * @returns {number} Distance in kilometers.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Great-circle distance between two lat/lon points, in meters. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}
