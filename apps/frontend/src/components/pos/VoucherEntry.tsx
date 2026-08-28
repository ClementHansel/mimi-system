'use client';

import { useState } from 'react';
import { Ticket, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/formatters';
import { ApiError, api } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { normalizeVoucherCode } from '@/lib/shared-types';
import type { Money, UUID } from '@/lib/shared-types';

/**
 * A voucher applied at the till, as `VoucherEntry` and its caller
 * (`PaymentPanel`) agree on it. Deliberately narrower than
 * `VoucherRedemptionDraft` (`packages/shared/src/voucher/index.ts`) — that
 * type is the SYNC payload shape (it also carries `offlineAccepted`, decided
 * by the offline policy at commit time, not here); this is just "what did
 * `/vouchers/check` say", which `PaymentPanel` then folds into the sync
 * payload alongside `channel`.
 */
export interface AppliedVoucher {
  voucherId: UUID;
  code: string;
  discount: Money;
  batchName: string;
}

/** `POST /vouchers/check` response shape (BFF contract, being built in parallel — see ticket). */
type VoucherCheckResponse =
  | { ok: true; voucherId: UUID; code: string; discount: Money; batchName: string }
  | { ok: false; code: string };

/**
 * Voucher-code entry for the payment flow (F-POS voucher redemption).
 *
 * TWO ROUND TRIPS ARE AVOIDED, NOT ONE. `normalizeVoucherCode` is the same
 * shared function `checkVoucher`'s callers use server-side — it accepts the
 * same sloppiness a cashier's typing has (lower case, missing dashes, O/0 and
 * I/L/1 confusion) and returns the canonical `MC-XXXX-XXXX` form, or `null`
 * when the input cannot possibly be a voucher code no matter how a server
 * looked it up (wrong length, symbols outside the alphabet even after the
 * confusable-character fixups). A `null` is therefore answered locally,
 * without a network call, because there is no rules question left to ask —
 * this is not a shortcut around the server check, it's skipping a request
 * that could only ever come back "not found" shaped as "malformed".
 */
export function VoucherEntry({
  subtotal,
  locationId,
  applied,
  onApplied,
}: {
  subtotal: Money;
  locationId: UUID;
  applied: AppliedVoucher | null;
  onApplied: (voucher: AppliedVoucher | null) => void;
}) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    const normalized = normalizeVoucherCode(input);
    if (normalized === null) {
      setError(t('voucher.pos.malformed'));
      return;
    }
    setChecking(true);
    setError(null);
    try {
      // `/vouchers/check` answers 200 IN BOTH ARMS — a refusal is
      // `{ ok: false, code }`, a business answer rather than a failure of the
      // request — so the BODY is what this branches on, never the HTTP status.
      // That is the right shape: treating "voucher not found" as an exception
      // would make this the one screen where a routine "tidak berlaku" prints
      // a stack trace in dev and a generic toast in prod instead of the
      // specific reason a queue can hear.
      //
      // The `catch` below therefore does NOT fire for a refused coupon. It is
      // kept for the request-level failures that can still throw — no network,
      // an expired session, a 403 from `voucher.redeem` — and it maps whatever
      // `code` those carry through the same table, falling back to `unknown`.
      // Deleting it would turn a dropped connection into an unhandled
      // rejection at the till.
      const res = await api.post<VoucherCheckResponse>('/vouchers/check', {
        code: normalized,
        subtotal,
        locationId,
      });
      if (res.ok) {
        onApplied({
          voucherId: res.voucherId,
          code: res.code,
          discount: res.discount,
          batchName: res.batchName,
        });
        setInput('');
      } else {
        setError(voucherErrorMessage(t, res.code));
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      setError(voucherErrorMessage(t, code));
    } finally {
      setChecking(false);
    }
  }

  function handleRemove() {
    onApplied(null);
    setInput('');
    setError(null);
  }

  if (applied) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-brand-200 bg-brand-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-brand-700">
            <Ticket className="size-4" aria-hidden />
            {t('voucher.pos.appliedBatch', {
              batch: applied.batchName,
              discount: formatMoney(applied.discount),
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<X className="size-4" />}
            onClick={handleRemove}
          >
            {t('voucher.pos.remove')}
          </Button>
        </div>
        {/* The server is authoritative on the discount amount (same honesty
            rule `statusForMethod` in `PaymentPanel` follows for `bank_transfer`
            — a number shown before the fact it depends on has settled must
            never be presented as final). The subtotal can still move after
            this check (more items added, a line discount edited), so the
            figure above is a PREVIEW of what `/vouchers/check` computed
            against the basket as it stood a moment ago, not a promise. */}
        <p className="text-xs text-brand-700/80">{t('voucher.pos.previewNote')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <Input
          label={t('voucher.pos.label')}
          placeholder={t('voucher.pos.placeholder')}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (error) setError(null);
          }}
          wrapperClassName="flex-1"
          disabled={checking}
        />
        <Button type="button" variant="outline" loading={checking} onClick={handleApply}>
          {t('voucher.pos.apply')}
        </Button>
      </div>
      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
}

/**
 * Maps each `ERR_VOUCHER_*` (the closed list in `checkVoucher`'s doc,
 * `packages/shared/src/error-codes.ts` ~line 85) to its own message, falling
 * back to a generic one for anything unrecognised. `checkVoucher`'s own
 * header explains why this must not collapse to one string: "tidak berlaku"
 * with no reason is what makes a queue argue — a customer with an expired
 * coupon needs to hear "expired", not the same flat refusal a wrong-outlet
 * code gets, or they push back on the cashier instead of understanding why.
 */
function voucherErrorMessage(t: (key: string, params?: Record<string, string>) => string, code: string): string {
  const key = `voucher.pos.error.${code}`;
  const translated = t(key);
  return translated === key ? t('voucher.pos.error.unknown') : translated;
}
