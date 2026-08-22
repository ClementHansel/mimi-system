import { formatMoney } from '@/lib/formatters';
import { specFor, type SettingField } from './settings-registry';

/**
 * Renders a setting's value as the sentence a manager would say.
 *
 * The old table had no value column at all, so "what is the void threshold
 * right now?" — the only question anyone opens this screen with — could not be
 * answered without clicking into a JSON textarea. Formatting lives here, apart
 * from React, so it can be tested directly on the real wire shapes.
 *
 * `t` is passed in rather than imported: this module stays pure, and the unit
 * names ("menit", "jam") come from the same i18n table as the rest of the UI.
 */
export function formatSettingValue(
  key: string,
  value: unknown,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const spec = specFor(key);
  if (!spec) return compactJson(value);

  switch (spec.field.kind) {
    case 'money':
      return typeof value === 'string' ? formatMoney(value) : compactJson(value);
    case 'boolean':
      return value === true ? t('common.yes') : t('common.no');
    case 'number':
      return typeof value === 'number' || typeof value === 'string'
        ? withUnit(String(value), spec.field.unit, t)
        : compactJson(value);
    case 'text':
      return typeof value === 'string' ? value : compactJson(value);
    case 'object':
      return formatObject(value, spec.field, t);
  }
}

/**
 * Objects become "Rp 15.000/jam · min 30 menit" — every field, in the spec's
 * order, joined. Deliberately NOT truncated to the first field: `hr.overtime`'s
 * rate is meaningless without its minimum, and a manager comparing two rows
 * needs both on the line.
 */
function formatObject(
  value: unknown,
  field: Extract<SettingField, { kind: 'object' }>,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (value === null || typeof value !== 'object') return compactJson(value);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const f of field.fields) {
    const raw = record[f.path];
    if (raw === null || raw === undefined) continue;
    if (f.field.kind === 'money') parts.push(formatMoney(String(raw)));
    else if (f.field.kind === 'boolean')
      parts.push(`${t(f.labelKey)}: ${raw ? t('common.yes') : t('common.no')}`);
    else if (f.field.kind === 'number') parts.push(withUnit(String(raw), f.field.unit, t));
    else parts.push(String(raw));
  }
  return parts.length > 0 ? parts.join(' · ') : compactJson(value);
}

function withUnit(
  n: string,
  unit: Extract<SettingField, { kind: 'number' }>['unit'],
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  return t(`admin.settings.unit.${unit}`, { n });
}

/**
 * Last resort for a shape this screen has no spec for (a setting added by a
 * later migration). One line, no newlines — a table cell is not a code block —
 * and truncated so one exotic value cannot blow the column width.
 */
function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? '—';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
