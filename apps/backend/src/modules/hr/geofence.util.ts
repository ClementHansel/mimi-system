/**
 * GPS geofence distance (FR-HR-01). Pure, no I/O — the radius itself is
 * NEVER a constant in the caller (CONTRACTS.md §1.7 `locations.geofence_radius_m`,
 * ticket instruction: "the radius is a setting, GEOFENCE_RADIUS_METERS, not a
 * constant"); this module only computes the measured distance so a
 * supervisor reviewing a dispute has the number, not just a pass/fail.
 */

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters (haversine). */
export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_M * c);
}

export interface GeofenceCheck {
  distanceM: number;
  ok: boolean;
}

/** Measures a claimed GPS point against a location's center + configured radius. */
export function checkGeofence(
  claimedLat: number,
  claimedLng: number,
  centerLat: number,
  centerLng: number,
  radiusM: number,
): GeofenceCheck {
  const distanceM = haversineDistanceMeters(claimedLat, claimedLng, centerLat, centerLng);
  return { distanceM, ok: distanceM <= radiusM };
}
