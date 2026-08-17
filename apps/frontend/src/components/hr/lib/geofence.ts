/**
 * Haversine great-circle distance — used to show the actual measured
 * distance between an `hr.attendance.check` capture and its location's
 * geofence centre (FR-HR-01), not just the backend's `geofenceOk` pass/fail.
 * A supervisor adjudicating a `time_suspect`/disputed row needs the number
 * ("42 m di luar radius"), and so does the employee who got rejected at
 * check-in — CONTRACTS §4.14 only returns `geofenceOk: boolean` on
 * `AttendanceRow`, so the distance itself is computed client-side from the
 * location's `latitude`/`longitude`/`geofenceRadiusM` (§4.3) and the
 * lat/lng captured at check-in/out.
 *
 * Pure math, no wire/backend dependency — kept decimal-string-in,
 * number-out on purpose: lat/lng travel as strings (NUMERIC(9,6) columns,
 * CONTRACTS §1.1) but a distance in meters is a display-only derived value,
 * never persisted or sent back to the API, so plain `number` is correct here
 * (unlike Money/Qty/Temp, which this file never touches).
 */
const EARTH_RADIUS_M = 6371000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Meters between two lat/lng pairs (decimal-string wire values, e.g. `"-1.234567"`). Returns `null` if either coordinate is unparseable. */
export function haversineDistanceMeters(
  lat1: string | number,
  lng1: string | number,
  lat2: string | number,
  lng2: string | number,
): number | null {
  const a1 = typeof lat1 === 'string' ? Number(lat1) : lat1;
  const o1 = typeof lng1 === 'string' ? Number(lng1) : lng1;
  const a2 = typeof lat2 === 'string' ? Number(lat2) : lat2;
  const o2 = typeof lng2 === 'string' ? Number(lng2) : lng2;
  if ([a1, o1, a2, o2].some((v) => Number.isNaN(v))) return null;

  const dLat = toRadians(a2 - a1);
  const dLng = toRadians(o2 - o1);
  const rLat1 = toRadians(a1);
  const rLat2 = toRadians(a2);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return Math.round(EARTH_RADIUS_M * c);
}

export interface GeofenceCheck {
  /** Rounded distance in meters from the capture point to the location centre, or `null` if geometry is missing. */
  distanceM: number | null;
  radiusM: number;
  /** `distanceM <= radiusM` — mirrors the backend's own pass/fail so the UI and the `ERR_GEOFENCE_OUT_OF_RANGE` rejection always agree; `null` distance is never treated as "inside". */
  withinRadius: boolean | null;
}

/** Combines the raw distance with the location's configured radius (`locations.geofence_radius_m`, default 100 m) into the one shape every geofence display (Absen, attendance review) needs. */
export function evaluateGeofence(
  capturedLat: string,
  capturedLng: string,
  locationLat: string | null,
  locationLng: string | null,
  radiusM: number,
): GeofenceCheck {
  if (locationLat === null || locationLng === null) {
    return { distanceM: null, radiusM, withinRadius: null };
  }
  const distanceM = haversineDistanceMeters(capturedLat, capturedLng, locationLat, locationLng);
  return { distanceM, radiusM, withinRadius: distanceM === null ? null : distanceM <= radiusM };
}
