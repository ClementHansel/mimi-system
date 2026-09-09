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
  Select,
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
import { useMeAttendanceStore, myLocalAttendance } from './lib/attendance-store';
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
  const actor = useActorMeta();

  /**
   * WHICH OUTLET this clock-in belongs to.
   *
   * This was `user?.locations[0]` — the first of however many the person is
   * assigned to, taken silently. A Supervisor Cabang covering three branches
   * therefore clocked in against whichever one happened to sort first, with
   * nothing on screen naming it and no way to change it (MA-201). The
   * attendance row is the record of where someone actually worked, so guessing
   * it is not a defensible default.
   *
   * One location: no choice to make, so no picker — it is shown as a plain
   * label. More than one: an explicit pick, and clock-in stays disabled until
   * it is made. That is deliberate friction. Defaulting to the first and merely
   * DISPLAYING it would still let someone who never looks at the field record
   * the wrong branch, which is the ambiguity this is meant to remove.
   */
  const assignedLocations = user?.locations ?? [];
  const [selectedLocationId, setSelectedLocationId] = useState<string>(
    assignedLocations.length === 1 ? (assignedLocations[0]?.id ?? '') : '',
  );
  const location = assignedLocations.find((l) => l.id === selectedLocationId) ?? null;

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [locationGeo, setLocationGeo] = useState<LocationGeo | null>(null);
  const [serverToday, setServerToday] = useState<AttendanceRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState<{ lat: string; lng: string; accuracy: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const persistedToday = useMeAttendanceStore((s) => s.today);
  // Only this employee's own record counts as a local fact — the blob is
  // per-browser and an outlet shares one machine. See `TodayAttendance.userId`.
  const localToday = myLocalAttendance(persistedToday, user?.id);
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
    // NOTHING PICKED YET IS A SETTLED STATE, NOT A LOADING ONE. This used to
    // `return` while leaving `loading` true, which was harmless when `location`
    // could never be null — and became a panel stuck on its spinner the moment a
    // multi-branch user started with no selection, hiding the very picker that
    // resolves it (MA-201).
    if (!location) {
      setLoading(false);
      return;
    }
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
    if (!location || !coords || !selfie || !runtime || !actor || !user) return;
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
        recordCheckIn(todayDate, user.id, attendanceId, occurredAt);
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

  // NOT ASSIGNED ANYWHERE is the dead end. NOTHING PICKED YET is not.
  //
  // This read `if (!location)` and `location` is now the SELECTED branch, so a
  // person covering several outlets — who deliberately starts with nothing
  // selected — would have been sent straight to "no location" and never shown
  // the picker that resolves it. Caught by the test for MA-201; worth keeping
  // the distinction visible, because the two conditions read alike and mean
  // opposite things.
  if (assignedLocations.length === 0) {
    return <EmptyState title={t('me.absen.noLocation')} size="lg" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          {/* The chosen branch, or the panel's own name until one is picked —
              `location` is nullable now that a multi-branch user starts with
              nothing selected. */}
          <CardTitle>{location?.name ?? t('me.absen.title')}</CardTitle>
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
                  {/* WHERE this clock-in is recorded. Named for everyone, and
                      chosen by anyone assigned to more than one branch — see
                      `selectedLocationId` for why it is not defaulted. */}
                  {assignedLocations.length > 1 ? (
                    <Select
                      label={t('me.absen.locationLabel')}
                      value={selectedLocationId}
                      onValueChange={setSelectedLocationId}
                      options={assignedLocations.map((l) => ({ value: l.id, label: l.name }))}
                      placeholder={t('me.absen.locationPlaceholder')}
                      hint={t('me.absen.locationHint')}
                      required
                    />
                  ) : (
                    location && (
                      <p className="text-sm text-text-secondary">
                        {t('me.absen.locationLabel')}:{' '}
                        <span className="font-medium text-text-primary">{location.name}</span>
                      </p>
                    )
                  )}

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
                      {/* AVAILABLE WHEN IT IS NEEDED. This was `{coords && …}`,
                          so the retry button appeared only once a position had
                          already been obtained — exactly when nobody needs it —
                          and was absent when permission was denied or
                          geolocation was unavailable. The user then saw an error,
                          a disabled clock-in button, and no way back (MA-202).
                          Rendered whenever the first attempt has settled either
                          way. */}
                      {(coords || geoError) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={requestLocation}
                          className="w-fit"
                        >
                          {t(geoError ? 'me.absen.retryLocation' : 'me.absen.refreshLocation')}
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
                    disabled={!location || !coords || !selfie || !runtime || !actor}
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
