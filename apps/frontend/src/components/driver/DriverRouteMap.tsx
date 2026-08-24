'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { useI18n } from '@/lib/i18n';
import type { Drop } from './lib/types';
import { googleMapsUrl, wazeUrl } from './lib/navigation';

/**
 * The driver's route on one map: every stop, numbered in the order gudang
 * planned, with the stop they are heading to next called out.
 *
 * WHY LEAFLET + OSM AND NOT GOOGLE MAPS — same reasoning as the dispatcher's
 * `LiveTruckMap`, and the owner reaffirmed it for this screen (2026-08-20)
 * after comparing against the laundry project's driver. Worth writing down,
 * because "use Google Maps like laundry does" sounds like it contradicts this
 * and does not: laundry has NO embedded map at all — it deep-links out to the
 * Google Maps app, which this screen already does too (see `navigation.ts`,
 * and note it hands over COORDINATES plus a Waze option, so it is already the
 * better version of that). What was missing was any way to SEE the route, and
 * an embedded map needs tiles: OSM's need no API key, no billing account and
 * no per-request cost, so this panel cannot become an outage when a card
 * expires.
 *
 * This map is for ORIENTATION, not navigation: "where am I going, in what
 * order, how far apart are the stops". Turn-by-turn stays with the phone's own
 * map app, which knows the roads and works from the offline cache. The dashed
 * line between stops is therefore drawn straight, deliberately — it is the
 * SEQUENCE, not a driving route, and drawing it as a convincing-looking road
 * path we had not actually routed would be a lie a driver might follow.
 *
 * ATTRIBUTION IS NOT OPTIONAL: the OSM credit is an ODbL/tile-policy
 * requirement, not decoration.
 *
 * Leaflet is imported DYNAMICALLY inside the effect because it touches
 * `window` at module scope and would break the App Router's server render.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Balikpapan — the gudang pusat. Only the view before any stop is geocoded, so the map never opens on the null island. */
const FALLBACK_CENTER: [number, number] = [-1.2379, 116.8529];

/**
 * Leaflet popups take an HTML STRING, which puts them outside React's escaping.
 * Outlet names and addresses are master data an admin can edit, so they are
 * untrusted for this purpose regardless of who typed them.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasCoords(d: Drop): d is Drop & { latitude: number; longitude: number } {
  return typeof d.latitude === 'number' && typeof d.longitude === 'number';
}

/**
 * A numbered pin drawn as a div, not an image. Leaflet's default marker icon
 * is loaded from a bundler-relative URL that breaks under Next's asset
 * pipeline (the well-known "marker icon 404" that leaves invisible markers);
 * a `divIcon` sidesteps that entirely AND lets the stop number be part of the
 * pin, which is the whole point of this map.
 */
function pinHtml(seq: number, done: boolean, next: boolean): string {
  const bg = done ? '#78716c' : next ? '#c2410c' : '#1c1917';
  const ring = next ? 'box-shadow:0 0 0 4px rgba(194,65,12,0.30);' : '';
  return `<div style="background:${bg};${ring}color:#fff;width:28px;height:28px;border-radius:9999px;
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;
    border:2px solid #fff;font-family:system-ui,sans-serif">${seq}</div>`;
}

export function DriverRouteMap({
  drops,
  nextDropId,
  focusedDropId,
}: {
  drops: Drop[];
  nextDropId: string | null;
  /** Stop the driver just tapped in the list — the map pans to it and opens its popup. */
  focusedDropId?: string | null;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  /** dropId -> its marker, so tapping a stop in the list can open that pin. */
  const markersRef = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const layersRef = useRef<{ remove: () => void }[]>([]);

  // Set once the Leaflet map instance exists.
  //
  // THE BUG THIS FIXES: both effects run on mount, in order. The init effect
  // below is async — it awaits `import('leaflet')` — so it returns to React
  // having created NOTHING, and the marker effect then runs immediately, reads
  // `mapRef.current === null` and bails. `mapRef` is a ref, so filling it in
  // later triggers no re-render; nothing ever re-ran the marker effect. The
  // result was a map that loaded its tiles perfectly and never drew a single
  // pin, with no console error, on data that was correct the whole way through.
  //
  // A ref cannot express "this is ready" to React. State can.
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const L = await import('leaflet');
      // Without Leaflet's CSS the tiles render as a scrambled stack of
      // unpositioned images, with no console error to explain it.
      await import('leaflet/dist/leaflet.css');
      if (cancelled || !containerRef.current || mapRef.current) return;

      mapRef.current = L.map(containerRef.current, {
        // A map that swallows one-finger page scroll is infuriating on a phone
        // held one-handed; the driver pans with two fingers or pinches to zoom.
        dragging: true,
        scrollWheelZoom: false,
      }).setView(FALLBACK_CENTER, 11);
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 18 }).addTo(mapRef.current);

      // Leaflet measures its container ONCE, at construction. Anything that
      // resizes it afterwards — the lg: breakpoint swapping the height, the
      // sidebar collapsing, a phone rotating — leaves it convinced it is still
      // the old size, and it renders grey bands where it never asked for tiles.
      // `invalidateSize` is the documented cure; a ResizeObserver is what
      // notices in the first place.
      if (containerRef.current && typeof ResizeObserver !== 'undefined') {
        resizeObserverRef.current = new ResizeObserver(() => {
          mapRef.current?.invalidateSize();
        });
        resizeObserverRef.current.observe(containerRef.current);
      }
      setMapReady(true);
    })();

    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      layersRef.current = [];
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');

      for (const layer of layersRef.current) layer.remove();
      layersRef.current = [];
      markersRef.current.clear();

      const located = drops.filter(hasCoords);
      if (located.length === 0) return;

      for (const d of located) {
        const done = d.status === 'completed' || d.status === 'completed_discrepancy';
        const marker = L.marker([d.latitude, d.longitude], {
          icon: L.divIcon({
            html: pinHtml(d.dropSeq, done, d.id === nextDropId),
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        })
          .addTo(map)
          // Tapping a pin has to DO something. Owner, 2026-08-24: "map with pins
          // that can be opened to use google map" — a driver looking at the map
          // is deciding where to go next, and making them scroll to find the
          // matching stop card to get a navigation link is the long way round.
          //
          // Built as an HTML string because Leaflet popups are outside React's
          // tree, so `escapeHtml` is doing real work: `locationName` and
          // `address` come from the database, and interpolating them raw is an
          // injection through master data.
          //
          // `target="_blank"` for the same reason `NavigateLink` uses it —
          // navigating away in-place would unmount the PWA and lose anything
          // queued in the offline outbox.
          .bindPopup(
            [
              `<strong>${escapeHtml(`${d.dropSeq}. ${d.locationName}`)}</strong>`,
              d.address ? `<div>${escapeHtml(d.address)}</div>` : '',
              `<div style="margin-top:6px;display:flex;gap:10px">`,
              `<a href="${googleMapsUrl(d)}" target="_blank" rel="noopener noreferrer">Google Maps</a>`,
              wazeUrl(d)
                ? `<a href="${wazeUrl(d)}" target="_blank" rel="noopener noreferrer">Waze</a>`
                : '',
              `</div>`,
            ].join(''),
          );
        layersRef.current.push(marker);
        markersRef.current.set(d.id, marker);
      }

      if (located.length > 1) {
        const line = L.polyline(
          located.map((d) => [d.latitude, d.longitude] as [number, number]),
          { color: '#c2410c', weight: 2, opacity: 0.65, dashArray: '6 6' },
        ).addTo(map);
        layersRef.current.push(line);
      }

      map.fitBounds(
        L.latLngBounds(located.map((d) => [d.latitude, d.longitude] as [number, number])),
        { padding: [36, 36], maxZoom: 14 },
      );
    })();
    // `mapReady` is the load-bearing dependency: it is what re-runs this effect
    // after the async init above finally produces a map.
  }, [drops, nextDropId, mapReady]);

  /**
   * Pan to the stop the driver tapped in the list and open its popup.
   *
   * Separate from the marker effect on purpose: re-running THAT would tear down
   * and rebuild every pin, which fights the map's own animation and loses the
   * popup it just opened. This one only moves the view.
   *
   * `setView` rather than `flyTo` — a driver glancing at a phone in a moving
   * vehicle wants the answer now, not a two-second camera glide.
   */
  useEffect(() => {
    if (!mapReady || !focusedDropId) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(focusedDropId);
    if (!map || !marker) return;
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
    marker.openPopup();
  }, [focusedDropId, mapReady]);

  const locatedCount = drops.filter(hasCoords).length;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        // Short on a phone, where it shares a small screen with the stop it
        // describes. Tall on a desktop, where the previous fixed 260px left a
        // stripe of map above a column of dead space while the stop list ran
        // hundreds of pixels further down the page.
        className="h-[260px] w-full rounded-lg border border-border lg:h-[calc(100vh-14rem)] lg:min-h-[420px]"
        role="application"
        aria-label={t('driver.map.label')}
      />
      {/* Silence here would read as "these are all the stops". A driver acting
          on a map that quietly omits a destination is the failure this line
          exists to prevent. */}
      {locatedCount < drops.length && (
        <p className="text-xs text-text-secondary">
          {t('driver.map.missingCoords', {
            missing: drops.length - locatedCount,
            total: drops.length,
          })}
        </p>
      )}
    </div>
  );
}
