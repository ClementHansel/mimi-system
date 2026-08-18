'use client';

import { useEffect, useState } from 'react';
import { MapPin, LogIn, LogOut } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  PhotoCapture,
  Badge,
  StatusBadge,
  EmptyState,
} from '@/components/ui';
import { useSessionStore } from '@/stores/session-store';
import { fmtTime, toDateInput } from '@/lib/dates';
import { evaluateGeofence } from '@/components/hr/lib/geofence';
import type { LocationGeo, AttendanceRow } from '@/components/hr/lib/types';
import { getLocationGeo, getMyAttendance } from './lib/me-api';
import { getMeRuntime, mintId, useActorMeta } from './lib/me-runtime';
import { useMeAttendanceStore } from './lib/attendance-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

/**
 * F11 `me` — Absen: check in/out with GPS + selfie (FR-HR-01), mobile-first.
 * Shows the MEASURED distance from the outlet, not just pass/fail — a
 * supervisor adjudicating a dispute needs the number, and so does the
 * employee who's about to get `ERR_GEOFENCE_OUT_OF_RANGE`'d.
 *
 * Check-in/out commit through `LocalRuntime.commitAttendanceCheckIn/Out`
 * (never a direct online POST) — this is THE offline-first case the whole
 * local-runtime/sync-projector machinery exists for: a staff member in a car
 * park at 6am with one bar of signal must have their check-in queue locally,
 * not fail outright. A failed check-in silently becomes an *alpha* day
 * (POUT-03), which is a wage deduction — so this path must never be blocked
 * on connectivity. Geofence distance is computed locally (see
 * `components/hr/lib/geofence.ts`) and works offline already; only the
 * commit itself changed.
 */
export function AbsenPanel() {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const location = user?.locations[0] ?? null;
  const actor = useActorMeta();

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [locationGeo, setLocationGeo] = useState<LocationGeo | null>(null);
  const [serverToday, setServerToday] = useState<AttendanceRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState<{ lat: string; lng: string; accuracy: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const localToday = useMeAttendanceStore((s) => s.today);
  const recordCheckIn = useMeAttendanceStore((s) => s.recordCheckIn);
  const recordCheckOut = useMeAttendanceStore((s) => s.recordCheckOut);
  const resetIfStale = useMeAttendanceStore((s) => s.resetIfStale);

  const todayDate = toDateInput(new Date());

  useEffect(() => {
    resetIfStale(todayDate);
  }, [todayDate, resetIfStale]);

  useEffect(() => {
    getMeRuntime().then(setRuntime);
  }, []);

  useEffect(() => {
    if (!location) return;
    setLoading(true);
    // Best-effort read: this GET is the online path (reads are never
    // queued, CONTRACTS-side there's nothing to reconcile), so it simply
    // fails quietly when offline — `localToday` below is what keeps the UI
    // correct in that case, not this fetch.
    Promise.all([
      getLocationGeo(location.id).catch(() => null),
      getMyAttendance(todayDate.slice(0, 7)).catch(() => [] as AttendanceRow[]),
    ])
      .then(([geo, rows]) => {
        setLocationGeo(geo);
        setServerToday(rows.find((r) => r.date === todayDate) ?? null);
      })
      .finally(() => setLoading(false));
  }, [location, todayDate]);

  function requestLocation() {
    setGeoError(null);
    if (!navigator.geolocation) {
      setGeoError(t('me.absen.geoUnavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setCoords({
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
          accuracy: Math.round(pos.coords.accuracy),
        }),
      () => setGeoError(t('me.absen.geoDenied')),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  useEffect(requestLocation, []);

  const geofence =
    coords && locationGeo
      ? evaluateGeofence(
          coords.lat,
          coords.lng,
          locationGeo.latitude,
          locationGeo.longitude,
          locationGeo.geofenceRadiusM,
        )
      : null;

  // Merge the online read with this device's own optimistic record — a
  // check-in queued offline (not yet synced, so absent from `serverToday`)
  // must still be reflected here, or the employee would be shown the
  // check-in button again and could double-submit.
  const hasCheckedIn = !!serverToday?.checkInAt || !!localToday?.checkedInAt;
  const hasCheckedOut = !!serverToday?.checkOutAt || !!localToday?.checkedOutAt;
  const mode: 'in' | 'out' | 'done' = !hasCheckedIn ? 'in' : !hasCheckedOut ? 'out' : 'done';

  async function submit() {
    if (!location || !coords || !selfie || !runtime || !actor) return;
    setBusy(true);
    try {
      const evidence = await runtime.captureEvidence(selfie, selfie.type, 'selfie');
      const occurredAt = new Date().toISOString();
      const body = {
        clientId: mintId(),
        locationId: location.id,
        lat: coords.lat,
        lng: coords.lng,
        accuracyM: coords.accuracy,
        selfieAttachmentId: evidence.attachmentId,
        at: occurredAt,
      };

      if (mode === 'in') {
        const attendanceId = mintId();
        await runtime.commitAttendanceCheckIn(attendanceId, body, actor);
        recordCheckIn(todayDate, attendanceId, occurredAt);
      } else {
        const attendanceId = serverToday?.id ?? localToday?.attendanceId;
        if (!attendanceId) throw new Error('missing attendanceId for check-out');
        await runtime.commitAttendanceCheckOut(attendanceId, body, actor);
        recordCheckOut(occurredAt);
      }

      setSelfie(null);
      toast({
        title: t(mode === 'in' ? 'me.absen.checkInSuccess' : 'me.absen.checkOutSuccess'),
        variant: 'success',
      });
    } catch {
      toast({ title: t('me.absen.submitFailed'), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (!location) {
    return <EmptyState title={t('me.absen.noLocation')} size="lg" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{location.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <div className="h-20 animate-pulse rounded-md bg-surface-sunken" />
          ) : (
            <>
              {(serverToday || localToday) && (
                <div className="flex flex-wrap items-center gap-2">
                  {serverToday && <StatusBadge domain="attendance" status={serverToday.status} />}
                  {!serverToday && localToday?.checkedInAt && (
                    <Badge variant="info" size="sm">
                      {t('me.absen.queuedLocally')}
                    </Badge>
                  )}
                  {(serverToday?.checkInAt ?? localToday?.checkedInAt) && (
                    <span className="text-sm text-text-secondary">
                      {t('me.absen.inAt', {
                        time: fmtTime(serverToday?.checkInAt ?? localToday?.checkedInAt ?? null),
                      })}
                    </span>
                  )}
                  {(serverToday?.checkOutAt ?? localToday?.checkedOutAt) && (
                    <span className="text-sm text-text-secondary">
                      {t('me.absen.outAt', {
                        time: fmtTime(serverToday?.checkOutAt ?? localToday?.checkedOutAt ?? null),
                      })}
                    </span>
                  )}
                </div>
              )}

              {mode === 'done' ? (
                <p className="text-sm text-text-muted">{t('me.absen.doneToday')}</p>
              ) : (
                <>
                  <div className="flex items-start gap-2 rounded-md border border-border-strong bg-surface-sunken p-3 text-sm">
                    <MapPin className="mt-0.5 size-4 flex-none text-text-muted" aria-hidden />
                    <div className="flex flex-col gap-1">
                      {geoError && <span className="text-danger-600">{geoError}</span>}
                      {!geoError && !coords && (
                        <span className="text-text-muted">{t('me.absen.gettingLocation')}</span>
                      )}
                      {geofence && (
                        <>
                          <span className="font-medium text-text-primary">
                            {geofence.distanceM === null
                              ? t('me.absen.distanceUnknown')
                              : t('me.absen.distanceValue', {
                                  distance: geofence.distanceM,
                                  radius: geofence.radiusM,
                                })}
                          </span>
                          <Badge
                            variant={geofence.withinRadius ? 'success' : 'danger'}
                            size="sm"
                            className="w-fit"
                          >
                            {geofence.withinRadius
                              ? t('me.absen.withinRadius')
                              : t('me.absen.outsideRadius')}
                          </Badge>
                        </>
                      )}
                      {!coords && !locationGeo && (
                        <span className="text-xs text-text-muted">
                          {t('me.absen.offlineGeofenceHint')}
                        </span>
                      )}
                      {coords && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={requestLocation}
                          className="w-fit"
                        >
                          {t('me.absen.refreshLocation')}
                        </Button>
                      )}
                    </div>
                  </div>

                  <PhotoCapture
                    label={t('me.absen.selfieLabel')}
                    value={selfie ? URL.createObjectURL(selfie) : null}
                    onCapture={setSelfie}
                    onRemove={() => setSelfie(null)}
                    required
                    disabled={busy}
                  />

                  <Button
                    size="touch-lg"
                    fullWidth
                    leftIcon={
                      mode === 'in' ? <LogIn className="size-5" /> : <LogOut className="size-5" />
                    }
                    loading={busy}
                    disabled={!coords || !selfie || !runtime || !actor}
                    onClick={submit}
                  >
                    {t(mode === 'in' ? 'me.absen.checkInButton' : 'me.absen.checkOutButton')}
                  </Button>
                  <p className="text-center text-xs text-text-muted">
                    {t('me.absen.queuesOfflineHint')}
                  </p>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
