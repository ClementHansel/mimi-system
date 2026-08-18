'use client';

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap, Marker } from 'leaflet';
import type { LiveDelivery } from '@/lib/shared-types';

/**
 * Leaflet map of every truck currently in transit.
 *
 * WHY LEAFLET + OSM AND NOT GOOGLE MAPS: owner's decision (2026-08-18). Leaflet
 * is a plain MIT library and OpenStreetMap tiles need no API key, no billing
 * account and no per-request cost, so the dispatcher's map cannot become a
 * production outage the day a card expires. The trade-off accepted with it is
 * that there is no routing, no ETA and no traffic here — this view answers
 * "where is the truck", and turn-by-turn stays with the driver's own map app.
 *
 * ATTRIBUTION IS NOT OPTIONAL. The OSM tile layer is used under the ODbL and
 * its tile-usage policy: the credit rendered in the corner is a licensing
 * requirement, not decoration — do not remove it. If this fleet grows enough to
 * make the volume unfriendly to OSM's donated tile servers, the fix is to point
 * `TILE_URL` at a paid tile host (Thunderforest, MapTiler, or self-hosted); no
 * other code here changes.
 *
 * Leaflet is imported DYNAMICALLY inside an effect rather than at module scope
 * because it touches `window` on import and would break the App Router's
 * server render outright.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Balikpapan — the gudang pusat. Used only as the initial view for the moment
 * before any truck has reported, so the map never opens on the null island. */
const FALLBACK_CENTER: [number, number] = [-1.2379, 116.8529];

export function LiveTruckMap({ deliveries }: { deliveries: LiveDelivery[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  // Only auto-fit the viewport the first time trucks appear. Refitting on every
  // poll would yank the map out from under a dispatcher who had panned or
  // zoomed to look at one truck.
  const hasFitted = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const L = await import('leaflet');
      // Leaflet's CSS must be loaded or the tiles render as a scrambled stack of
      // unpositioned images — a classic silent failure with no console error.
      await import('leaflet/dist/leaflet.css');
      if (cancelled || !containerRef.current || mapRef.current) return;

      mapRef.current = L.map(containerRef.current).setView(FALLBACK_CENTER, 10);
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 18 }).addTo(mapRef.current);
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      hasFitted.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');
      const positioned = deliveries.filter((d) => d.lastPosition !== null);
      const seen = new Set<string>();

      for (const d of positioned) {
        const pos = d.lastPosition!;
        seen.add(d.sjId);
        const latlng: [number, number] = [pos.latitude, pos.longitude];
        const label = [d.sjNumber, d.vehiclePlate, d.driverName].filter(Boolean).join(' · ');

        const existing = markersRef.current.get(d.sjId);
        if (existing) {
          // Move the existing marker rather than recreating it: a rebuilt marker
          // closes any popup the dispatcher had open, every poll.
          existing.setLatLng(latlng);
          existing.setPopupContent(label);
          continue;
        }
        const marker = L.marker(latlng).addTo(map).bindPopup(label);
        markersRef.current.set(d.sjId, marker);
      }

      // Drop markers for trips that finished or fell off the board.
      for (const [sjId, marker] of markersRef.current) {
        if (!seen.has(sjId)) {
          marker.remove();
          markersRef.current.delete(sjId);
        }
      }

      if (!hasFitted.current && positioned.length > 0) {
        const bounds = L.latLngBounds(
          positioned.map((d) => [d.lastPosition!.latitude, d.lastPosition!.longitude]),
        );
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        hasFitted.current = true;
      }
    })();
  }, [deliveries]);

  return (
    <div
      ref={containerRef}
      className="h-[420px] w-full rounded-lg border border-border"
      role="application"
      aria-label="Peta posisi truk"
    />
  );
}
