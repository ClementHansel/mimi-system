'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { VoucherType } from '@/lib/shared-types';
import type { Money, Paginated, UUID } from '@/lib/shared-types';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { createVoucherBatch, updateVoucherBatch } from './voucher-api';
import type { VoucherBatch, VoucherBatchInput } from './types';
import { errMsg } from '@/lib/api-error';

/**
 * A location as this modal needs it — id + name only. Fetched from
 * `GET /locations`, the same endpoint `components/purchasing/lib/api.ts`'s
 * `getLocations` calls, but declared and fetched locally rather than
 * importing that helper: `components/purchasing/**` is out of bounds for
 * this ticket, and a two-field read model is not worth threading a
 * cross-boundary import for.
 */
interface LocationOption {
  id: UUID;
  name: string;
}

/**
 * Percentage parsing, kept separate from `parseMoneyInput` (`@/lib/formatters`)
 * because a voucher percentage is NOT money — it is the `'10.00'`-style
 * decimal `VoucherRules.value`/`divideByHundred` (`packages/shared/src/voucher/index.ts`)
 * expect, capped at 2 fractional digits (anything finer is rejected server-side
 * rather than silently truncated). Built as a regex/string check rather than
 * `Number()`/`parseFloat`, matching this codebase's D-10 discipline for every
 * decimal that travels the wire — a percentage is no different from a money
 * value in that respect, even though it is not typed `Money`.
 */
function parsePercentInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return trimmed;
}

const EMPTY_FORM = {
  name: '',
  type: VoucherType.Fixed,
  valueDraft: '',
  minSubtotal: null as Money | null,
  maxDiscount: null as Money | null,
  validFrom: '',
  validUntil: '',
  allOutlets: true,
  locationIds: [] as UUID[],
  terms: '',
};

/**
 * Create/edit form for a voucher batch (FR side: `voucher.manage`). Reused
 * for both — `batch` is `null` for create, a `VoucherBatch` for edit — same
 * shape as `SupplierFormModal`'s single-modal-two-modes idiom.
 *
 * `value` is the one field whose INPUT WIDGET depends on `type`: fixed is a
 * rupiah amount (`MoneyInput`), percentage is a plain `Input` parsed through
 * `parsePercentInput` above — sharing `MoneyInput` for both would either let
 * a percentage be typed as "Rp10" (nonsensical) or silently reinterpret a
 * percentage's digits as rupiah on the fixed path.
 */
export function VoucherBatchModal({
  batch,
  onClose,
  onSaved,
}: {
  batch: VoucherBatch | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<Paginated<LocationOption>>('/locations?active=true&pageSize=200')
      .then((r) => setLocations(r.rows))
      .catch(() => {
        // Non-fatal: without a location list the form still works as
        // "all outlets", which is the safe default (see EMPTY_FORM).
      });
  }, []);

  useEffect(() => {
    if (!batch) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      name: batch.name,
      type: batch.type,
      valueDraft: batch.value,
      minSubtotal: batch.minSubtotal,
      maxDiscount: batch.maxDiscount,
      validFrom: batch.validFrom,
      validUntil: batch.validUntil,
      allOutlets: batch.locationIds === null,
      locationIds: batch.locationIds ?? [],
      terms: batch.terms ?? '',
    });
  }, [batch]);

  const parsedValue =
    form.type === VoucherType.Fixed
      ? form.valueDraft || null // MoneyInput already hands back a canonical Money string
      : parsePercentInput(form.valueDraft);

  const canSubmit =
    form.name.trim() !== '' &&
    parsedValue !== null &&
    form.minSubtotal !== null &&
    form.validFrom !== '' &&
    form.validUntil !== '' &&
    form.validFrom <= form.validUntil &&
    !submitting;

  function toggleLocation(id: UUID, checked: boolean) {
    setForm((f) => ({
      ...f,
      locationIds: checked ? [...f.locationIds, id] : f.locationIds.filter((x) => x !== id),
    }));
  }

  async function submit() {
    if (!canSubmit || parsedValue === null || form.minSubtotal === null) {
      setError(t('validation.required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const body: VoucherBatchInput = {
      name: form.name.trim(),
      type: form.type,
      value: parsedValue,
      minSubtotal: form.minSubtotal,
      maxDiscount: form.type === VoucherType.Percentage ? form.maxDiscount : null,
      validFrom: form.validFrom,
      validUntil: form.validUntil,
      locationIds: form.allOutlets ? null : form.locationIds,
      terms: form.terms.trim() || null,
    };
    try {
      if (batch) {
        await updateVoucherBatch(batch.id, body);
      } else {
        await createVoucherBatch(body);
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={batch ? t('voucher.editTitle') : t('voucher.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!canSubmit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}

        <Input
          label={t('voucher.name')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('voucher.columnType')}
            value={form.type}
            onValueChange={(v) =>
              setForm((f) => ({ ...f, type: v as VoucherType, valueDraft: '', maxDiscount: null }))
            }
            options={Object.values(VoucherType).map((v) => ({
              value: v,
              label: t(`voucher.type.${v}`),
            }))}
          />

          {form.type === VoucherType.Fixed ? (
            <MoneyInput
              label={t('voucher.value')}
              value={(form.valueDraft || null) as Money | null}
              onChange={(v) => setForm((f) => ({ ...f, valueDraft: v ?? '' }))}
              required
            />
          ) : (
            <Input
              label={t('voucher.value')}
              value={form.valueDraft}
              onChange={(e) => setForm((f) => ({ ...f, valueDraft: e.target.value }))}
              placeholder="10.00"
              hint={t('voucher.percentHint')}
              required
            />
          )}

          <MoneyInput
            label={t('voucher.minSubtotal')}
            value={form.minSubtotal}
            onChange={(v) => setForm((f) => ({ ...f, minSubtotal: v }))}
            required
          />

          {form.type === VoucherType.Percentage && (
            <MoneyInput
              label={t('voucher.maxDiscount')}
              value={form.maxDiscount}
              onChange={(v) => setForm((f) => ({ ...f, maxDiscount: v }))}
              hint={t('voucher.maxDiscountHint')}
            />
          )}

          <Input
            label={t('voucher.validFrom')}
            type="date"
            value={form.validFrom}
            onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
            required
          />
          <Input
            label={t('voucher.validUntil')}
            type="date"
            value={form.validUntil}
            onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
            required
          />
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <Checkbox
            label={t('voucher.allOutlets')}
            checked={form.allOutlets}
            onCheckedChange={(checked) => setForm((f) => ({ ...f, allOutlets: checked }))}
          />
          {!form.allOutlets && (
            <div className="flex flex-col gap-1.5 pl-7">
              {locations.length === 0 && (
                <p className="text-sm text-text-muted">{t('common.loading')}</p>
              )}
              {locations.map((loc) => (
                <Checkbox
                  key={loc.id}
                  label={loc.name}
                  checked={form.locationIds.includes(loc.id)}
                  onCheckedChange={(checked) => toggleLocation(loc.id, checked)}
                />
              ))}
            </div>
          )}
        </div>

        <Textarea
          label={t('voucher.terms')}
          value={form.terms}
          onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))}
        />
      </div>
    </Modal>
  );
}
