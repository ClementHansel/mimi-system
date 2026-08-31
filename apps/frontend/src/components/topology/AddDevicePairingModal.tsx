'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Select, Button } from '@/components/ui';
import { fmtTime } from '@/lib/dates';
import { DeviceCategory } from '@/lib/shared-types';
import { mintDevicePairingToken, type MintedPairingToken } from './lib/device-api';

const PAIRING_TOKEN_TTL_MIN = 15; // §7.2/§4.21 — matches PairingTokensService's fixed TTL.

function msRemaining(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}
import { errMsg } from '@/lib/api-error';

function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * "Add device" (owner: "there is no way to add devices"). Backend already
 * supports this — `POST /devices/pairing-tokens` mints a 15-minute,
 * single-use token (`PairingTokensService`, TTL hardcoded there, mirrored
 * here only for the "15 menit" copy — the real deadline this component acts
 * on is always the server's own `expiresAt`). The token itself is never
 * shown; only `displayCode` (12 chars, no ambiguous 0/O/1/I/L — built to be
 * read aloud) is, per `PairingTokensService`'s own doc comment on why that
 * alphabet exists.
 *
 * Redeeming the code (`POST /devices/register`) happens on the tablet/node
 * itself, not in this dashboard — this modal's only job is producing a code
 * a dispatcher can read over the phone or hand to someone at the outlet
 * before it expires.
 */
export function AddDevicePairingModal({
  locations,
  defaultLocationId,
  onClose,
}: {
  locations: { id: string; name: string }[];
  defaultLocationId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [locationId, setLocationId] = useState(defaultLocationId ?? '');
  const [category, setCategory] = useState('');
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MintedPairingToken | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Ticks the countdown while a result is showing — the whole point of
  // surfacing this is "this code goes stale soon," which a static timestamp
  // says once and a live countdown keeps saying.
  useEffect(() => {
    if (!result) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [result]);

  async function submit() {
    if (!locationId) return;
    setMinting(true);
    setError(null);
    try {
      const minted = await mintDevicePairingToken({
        locationId,
        suggestedCategory: category || undefined,
      });
      setResult(minted);
      setNow(Date.now());
    } catch (err) {
      setError(errMsg(err, t('topology.addDevice.error')));
    } finally {
      setMinting(false);
    }
  }

  function mintAnother() {
    setResult(null);
    setError(null);
  }

  // `now` (ticked by the effect above) exists only to force this re-render
  // every second; `msRemaining` itself always reads a fresh `Date.now()`.
  void now;
  const liveRemaining = result ? msRemaining(result.expiresAt) : 0;
  const expired = !!result && liveRemaining <= 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={result ? t('topology.addDevice.resultTitle') : t('topology.addDevice.title')}
      description={result ? undefined : t('topology.addDevice.description')}
      footer={
        result ? (
          expired ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t('topology.addDevice.done')}
              </Button>
              <Button onClick={mintAnother}>{t('topology.addDevice.another')}</Button>
            </>
          ) : (
            <Button onClick={onClose}>{t('topology.addDevice.done')}</Button>
          )
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} loading={minting} disabled={!locationId}>
              {t('topology.addDevice.submit')}
            </Button>
          </>
        )
      }
    >
      {!result && (
        <div className="flex flex-col gap-3">
          <Select
            label={t('topology.addDevice.locationLabel')}
            placeholder={t('topology.addDevice.locationPlaceholder')}
            value={locationId}
            onValueChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
          />
          <Select
            label={t('topology.addDevice.categoryLabel')}
            placeholder={t('topology.addDevice.categoryPlaceholder')}
            value={category}
            onValueChange={setCategory}
            options={Object.values(DeviceCategory)
              .filter((c) => c !== DeviceCategory.BRANCH_NODE) // node pairing is a different endpoint — see device-api.ts
              .map((c) => ({ value: c, label: t(`topology.device.category.${c}`) }))}
          />
          {error && <p className="text-sm text-danger-600">{error}</p>}
        </div>
      )}

      {result && (
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <p className="text-sm text-text-muted">{t('topology.addDevice.resultHint')}</p>
          <div
            className={
              expired
                ? 'rounded-lg border border-border bg-surface-sunken px-6 py-4 font-mono text-3xl font-semibold tracking-[0.3em] text-text-muted line-through'
                : 'rounded-lg border border-brand-200 bg-brand-50 px-6 py-4 font-mono text-3xl font-semibold tracking-[0.3em] text-brand-700'
            }
          >
            {result.displayCode}
          </div>
          {expired ? (
            <p className="text-sm font-medium text-danger-600">{t('topology.addDevice.expired')}</p>
          ) : (
            <p className="text-sm text-text-secondary">
              {t('topology.addDevice.expiresIn', {
                minutes: PAIRING_TOKEN_TTL_MIN,
                time: fmtTime(result.expiresAt),
              })}{' '}
              <span className="font-mono font-semibold text-text-primary">
                {fmtCountdown(liveRemaining)}
              </span>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
