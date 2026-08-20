'use client';

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { useI18n } from '@/lib/i18n';
import type { Drop } from './lib/types';

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
}: {
  drops: Drop[];
  nextDropId: string | null;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<{ remove: () => void }[]>([]);

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
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');

      for (const layer of layersRef.current) layer.remove();
      layersRef.current = [];

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
          .bindPopup(`<strong>${d.dropSeq}. ${d.locationName}</strong><br/>${d.address ?? ''}`);
        layersRef.current.push(marker);
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
  }, [drops, nextDropId]);

  const locatedCount = drops.filter(hasCoords).length;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        className="h-[260px] w-full rounded-lg border border-border"
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
