'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { newUuid } from '@/lib/uuid';

/**
 * Reports the truck's position to gudang while a Surat Jalan is in transit.
 *
 * WHY THIS DOES NOT USE THE OFFLINE OUTBOX. Every driver *domain* mutation
 * (depart/arrive/receive/temp log) goes through `driver-runtime.ts`'s
 * `LocalRuntime`, and this file deliberately does not. Positions are telemetry,
 * not domain events: they have no entry in `@mimi/sync-protocol`'s schema
 * registry, and inventing one is a sync-protocol decision rather than a screen
 * decision — the same discipline `driver-api.ts` already documents for the
 * unmapped `fail` op. Just as importantly, the outbox is an ordered, durable
 * queue of facts that MUST all eventually land; a dropped breadcrumb is
 * inconsequential, and letting hundreds of pings an hour compete with a serah
 * terima for outbox drain would be actively harmful. So this keeps its own
 * small, lossy-by-design buffer.
 *
 * COLLECTION WINDOW. Only while `enabled` (the caller passes the SJ's
 * `in_transit` state). The backend enforces the same rule independently, so a
 * leaked timer cannot keep writing location after the trip ends.
 */

/** One buffered fix, shaped for `POST /delivery/surat-jalan/:id/positions`. */
interface BufferedFix {
  clientId: string;
  latitude: number;
  longitude: number;
  accuracyM?: number;
  speedKph?: number;
  headingDeg?: number;
  recordedAt: string;
}

export type TrackingState = 'idle' | 'active' | 'denied' | 'unsupported';

/** Don't record more often than this. A delivery truck's useful resolution is
 * "which road is it on", not "which metre" — and a tighter cadence would
 * multiply an already unbounded table (migration 221) for no operational gain. */
const MIN_INTERVAL_MS = 60_000;

/** Flush when this many fixes are buffered, or on the interval below —
 * whichever comes first. Bounded well under the API's 200-per-batch cap. */
const FLUSH_AT = 5;
const FLUSH_INTERVAL_MS = 120_000;

/** Stop the buffer growing without bound across a long dead zone. At one fix a
 * minute this is ~4 hours of backlog; past that the OLDEST are dropped, because
 * on reconnect the dispatcher cares far more about where the truck is now than
 * where it was four hours ago. */
const MAX_BUFFER = 240;

export function useTripTracking(sjId: string | null, enabled: boolean) {
  const [state, setState] = useState<TrackingState>('idle');
  const [pending, setPending] = useState(0);

  const buffer = useRef<BufferedFix[]>([]);
  const lastRecordedAt = useRef(0);
  // Guards against two flushes overlapping (interval firing while a slow
  // request from the size-trigger is still in flight), which would send the
  // same fixes twice. Harmless server-side thanks to `clientId`, but it would
  // double the traffic on exactly the weak connection we are trying to spare.
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (!sjId || flushing.current || buffer.current.length === 0) return;
    flushing.current = true;
    // Take the batch out of the buffer up front so fixes arriving mid-request
    // are not lost, and put it BACK on failure rather than dropping it.
    const batch = buffer.current.splice(0, 200);
    try {
      await api.post(`/delivery/surat-jalan/${sjId}/positions`, { positions: batch });
    } catch {
      // Offline, or the trip is no longer in transit. Re-queue at the front and
      // let the next tick retry; the trim below stops this growing for ever.
      buffer.current = [...batch, ...buffer.current].slice(-MAX_BUFFER);
    } finally {
      flushing.current = false;
      setPending(buffer.current.length);
    }
  }, [sjId]);

  useEffect(() => {
    if (!enabled || !sjId) {
      setState('idle');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('unsupported');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setState('active');
        const now = Date.now();
        if (now - lastRecordedAt.current < MIN_INTERVAL_MS) return;
        lastRecordedAt.current = now;

        const c = pos.coords;
        buffer.current.push({
          clientId: newUuid(),
          latitude: c.latitude,
          longitude: c.longitude,
          // The Geolocation API reports m/s and may report null; the wire
          // contract is km/h, so convert once, here.
          accuracyM: Number.isFinite(c.accuracy) ? c.accuracy : undefined,
          speedKph:
            typeof c.speed === 'number' && Number.isFinite(c.speed) ? c.speed * 3.6 : undefined,
          headingDeg:
            typeof c.heading === 'number' && Number.isFinite(c.heading) ? c.heading : undefined,
          recordedAt: new Date(pos.timestamp).toISOString(),
        });
        if (buffer.current.length > MAX_BUFFER) {
          buffer.current = buffer.current.slice(-MAX_BUFFER);
        }
        setPending(buffer.current.length);
        if (buffer.current.length >= FLUSH_AT) void flush();
      },
      (err) => {
        // PERMISSION_DENIED is the one worth surfacing to the driver: it is the
        // difference between "gudang can see me" and a silently untracked truck
        // that dispatch will assume is broken down.
        setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unsupported');
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 },
    );

    const timer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(timer);
      // Best-effort final flush so the last leg is not lost when the driver
      // closes the screen. Fire-and-forget: there is nothing useful to await
      // during unmount, and a rejection here is already handled inside `flush`.
      void flush();
    };
  }, [enabled, sjId, flush]);

  return { state, pending };
}
