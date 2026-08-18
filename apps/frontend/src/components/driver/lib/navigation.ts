/**
 * Turn-by-turn navigation, by DEEP LINK into whatever map app the driver
 * already has, rather than by embedding a routing SDK.
 *
 * Owner's decision (2026-08-18) and the right one for this fleet: an embedded
 * Directions API would cost per request, need a billed API key as a hard
 * production dependency, and still be worse at navigating Kalimantan than
 * Google Maps or Waze — which every driver already has installed, already
 * knows, and which already work with the phone's own offline map cache. This
 * module's whole job is to hand those apps a destination.
 *
 * There is no `route` concept here on purpose: the driver navigates ONE stop at
 * a time, in the order gudang planned. Handing the map app a full multi-stop
 * route would let it re-optimise the sequence, silently overriding the
 * dispatcher's order — which is exactly what the warehouse route planner exists
 * to control (a truck is loaded back-to-front for a reason).
 */

export interface NavTarget {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  locationName: string;
}

/** True when we can hand a map app something it can actually navigate to. */
export function canNavigate(target: NavTarget): boolean {
  return hasCoords(target) || !!target.address?.trim();
}

function hasCoords(t: NavTarget): t is NavTarget & { latitude: number; longitude: number } {
  return typeof t.latitude === 'number' && typeof t.longitude === 'number';
}

/**
 * Google Maps universal URL. Chosen as the default because it is the one form
 * that behaves everywhere: it opens the native app on Android and iOS when
 * installed and falls back to the browser when not.
 *
 * Deliberately NOT the `geo:` URI, which is the more "correct" platform-neutral
 * scheme but is unsupported on iOS — a driver on an iPhone would get a dead
 * link, and a dead Navigate button on a delivery run is worse than no button.
 *
 * Coordinates win over the address when both exist: every location here is
 * geocoded, and a street address in Samarinda resolves far less reliably than
 * a lat/long pair.
 */
export function googleMapsUrl(target: NavTarget): string {
  const destination = hasCoords(target)
    ? `${target.latitude},${target.longitude}`
    : `${target.address ?? target.locationName}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

/**
 * Waze. Offered alongside Google Maps because it is widely used by Indonesian
 * drivers for live traffic. Waze can only navigate to coordinates via this
 * link form, so callers should hide the option when there are none rather than
 * send the driver to a search screen.
 */
export function wazeUrl(target: NavTarget): string | null {
  if (!hasCoords(target)) return null;
  return `https://waze.com/ul?ll=${target.latitude},${target.longitude}&navigate=yes`;
}

/** A copy-and-paste friendly "lat, long", shown under the address so a driver
 * can read coordinates down the phone to someone who is lost. */
export function formatCoords(target: NavTarget): string | null {
  if (!hasCoords(target)) return null;
  return `${target.latitude.toFixed(6)}, ${target.longitude.toFixed(6)}`;
}
