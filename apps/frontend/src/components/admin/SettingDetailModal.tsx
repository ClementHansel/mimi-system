'use client';

import { useState } from 'react';
import { Info, Lock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Textarea } from '@/components/ui/Textarea';
import { specFor, valueAt, type SettingField } from './lib/settings-registry';
import type { Setting } from './types';
import type { Money } from '@/lib/shared-types';

/**
 * One setting, explained and edited in its own terms.
 *
 * The old modal was a JSON textarea with the raw key as its title — so raising
 * the void-refund approval limit meant knowing that the wire shape is
 * `{"managerAboveIdr": "200000.00"}` and that the number is a decimal STRING.
 * The owner's verdict was "confusing for normal user", and it was worse than
 * confusing: a mistyped shape is accepted by the API and only fails later,
 * inside an approval chain.
 *
 * So this modal renders FIELDS from the registry's spec — a money box for a
 * threshold, minutes for a grace period — and reassembles the exact wire shape
 * on save. Three things it deliberately keeps:
 *
 *  - The raw key, small, at the bottom. Support conversations need it.
 *  - Who changed it last and when. A setting is a decision someone made.
 *  - An "advanced" raw-JSON escape hatch for shapes the registry has no spec
 *     for, so an unrecognised setting stays editable instead of becoming
 *     read-only the moment a migration adds one.
 */
export function SettingDetailModal({
  setting,
  onClose,
  onSaved,
}: {
  setting: Setting;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const spec = specFor(setting.key);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Draft state per shape. Scalars use `scalar`; object specs use a path->string
  // map. Both start from the CURRENT value, so an edit to one field never
  // silently blanks its siblings.
  const [scalar, setScalar] = useState<string>(
    spec && spec.field.kind !== 'object' ? stringifyScalar(setting.value) : '',
  );
  const [bool, setBool] = useState<boolean>(setting.value === true);
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (!spec || spec.field.kind !== 'object') return {};
    const out: Record<string, string> = {};
    for (const f of spec.field.fields) out[f.path] = valueAt(setting.value, f.path);
    return out;
  });
  const [raw, setRaw] = useState(JSON.stringify(setting.value, null, 2));
  const [showRaw, setShowRaw] = useState(!spec);

  const readOnly = !!spec?.managedElsewhere;

  /** Rebuilds the exact wire value from whichever editor is in use. */
  function buildValue(): unknown {
    if (showRaw || !spec) return JSON.parse(raw);
    if (spec.field.kind === 'boolean') return bool;
    if (spec.field.kind === 'money' || spec.field.kind === 'text') return scalar;
    if (spec.field.kind === 'number') return Number(scalar);
    // Object: preserve every key the server sent, overwriting only the ones
    // this spec exposes. A value may carry fields the registry does not know
    // about (`company.profile.logoAttachmentId`), and dropping them on save
    // would be a silent data loss.
    const base =
      setting.value && typeof setting.value === 'object'
        ? { ...(setting.value as Record<string, unknown>) }
        : {};
    for (const f of spec.field.fields) {
      const text = fields[f.path] ?? '';
      if (text === '' && f.optional) continue;
      base[f.path] =
        f.field.kind === 'number'
          ? Number(text)
          : f.field.kind === 'boolean'
            ? text === 'true'
            : text;
    }
    return base;
  }

  async function submit() {
    setError(null);
    let value: unknown;
    try {
      value = buildValue();
    } catch {
      setError(t('admin.settings.invalidJson'));
      return;
    }
    setSubmitting(true);
    try {
      await api.put(`/settings/${setting.key}`, { value });
      toast({ title: t('admin.settings.updateSuccess'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={spec ? t(spec.labelKey) : setting.key}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t(readOnly ? 'common.close' : 'common.cancel')}
          </Button>
          {!readOnly && (
            <Button onClick={submit} loading={submitting}>
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}

        {/* What changing this actually does — the thing the raw description
            never said in a language an owner reads. */}
        <p className="flex items-start gap-2 rounded-md bg-info-50 px-3 py-2 text-sm text-info-700">
          <Info className="mt-0.5 size-4 flex-none" aria-hidden />
          <span>{spec ? t(spec.helpKey) : t('admin.settings.noSpecHelp')}</span>
        </p>

        {readOnly ? (
          <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
            <Lock className="mt-0.5 size-4 flex-none" aria-hidden />
            <span>{t(spec!.managedElsewhere!.noteKey)}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {!showRaw && spec && <SpecFields spec={spec.field} />}
            {showRaw && (
              <Textarea
                label={t('admin.settings.rawJsonLabel')}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                hint={t('admin.settings.rawJsonHint')}
                rows={10}
                className="font-mono text-xs"
              />
            )}
            {spec && (
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="self-start text-xs text-text-muted underline hover:text-text-primary"
              >
                {t(showRaw ? 'admin.settings.hideRaw' : 'admin.settings.showRaw')}
              </button>
            )}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
          <dt className="text-text-muted">{t('admin.settings.columnUpdatedBy')}</dt>
          <dd className="text-text-primary">{setting.updatedBy ?? '—'}</dd>
          <dt className="text-text-muted">{t('admin.settings.columnUpdatedAt')}</dt>
          <dd className="text-text-primary">{fmtDateTime(setting.updatedAt)}</dd>
          <dt className="text-text-muted">{t('admin.settings.columnKey')}</dt>
          <dd className="break-all font-mono text-text-secondary">{setting.key}</dd>
        </dl>
      </div>
    </Modal>
  );

  /** Renders the spec's fields. Nested so it can close over the draft state. */
  function SpecFields({ spec: field }: { spec: SettingField }) {
    if (field.kind === 'boolean') {
      return (
        <Checkbox
          label={t('admin.settings.enabledLabel')}
          checked={bool}
          onCheckedChange={setBool}
        />
      );
    }
    if (field.kind === 'money') {
      return (
        <MoneyInput
          label={t('admin.settings.valueLabel')}
          value={(scalar || null) as Money | null}
          onChange={(v) => setScalar(v ?? '')}
        />
      );
    }
    if (field.kind === 'number') {
      return (
        <Input
          label={t('admin.settings.valueLabel')}
          type="number"
          inputMode="numeric"
          value={scalar}
          onChange={(e) => setScalar(e.target.value)}
          hint={t(`admin.settings.unitHint.${field.unit}`)}
        />
      );
    }
    if (field.kind === 'text') {
      return (
        <Input
          label={t('admin.settings.valueLabel')}
          value={scalar}
          onChange={(e) => setScalar(e.target.value)}
        />
      );
    }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {field.fields.map((f) =>
          f.field.kind === 'money' ? (
            <MoneyInput
              key={f.path}
              label={t(f.labelKey)}
              value={(fields[f.path] || null) as Money | null}
              onChange={(v) => setFields((prev) => ({ ...prev, [f.path]: v ?? '' }))}
            />
          ) : f.field.kind === 'boolean' ? (
            <Checkbox
              key={f.path}
              label={t(f.labelKey)}
              checked={fields[f.path] === 'true'}
              onCheckedChange={(checked) =>
                setFields((prev) => ({ ...prev, [f.path]: checked ? 'true' : 'false' }))
              }
            />
          ) : (
            <Input
              key={f.path}
              label={t(f.labelKey)}
              type={f.field.kind === 'number' ? 'number' : 'text'}
              inputMode={f.field.kind === 'number' ? 'numeric' : undefined}
              value={fields[f.path] ?? ''}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.path]: e.target.value }))}
              hint={
                f.field.kind === 'number' ? t(`admin.settings.unitHint.${f.field.unit}`) : undefined
              }
            />
          ),
        )}
      </div>
    );
  }
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value);
}
