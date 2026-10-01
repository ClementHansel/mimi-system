import { formatMoney, formatNumber, formatQty } from '@/lib/formatters';
import type { Money, Qty } from '@/lib/shared-types';
import type { AnomalyItem, DrillColumn } from './anomaly-types';

/** `detail` keys that carry a Money decimal string — formatted as Rupiah before they reach a sentence. */
const MONEY_DETAIL_KEYS = new Set([
  'value',
  'sales',
  'closingStockValue',
  'gross',
  'deductions',
  'net',
  'base',
  'balance',
  'qris',
  'transfer',
  'gap',
]);

/**
 * The i18n key of the sentence that explains one finding. Most metrics have
 * exactly one; a few vary by an input that changes the sentence itself
 * (a revenue spike vs a collapse, a payroll net-pay rule vs the deductions one).
 */
export function detailKey(item: AnomalyItem): string {
  const base = `dashboard.anomaly.detail.${item.metric}`;
  if (item.metric === 'revenue')
    return `${base}.${item.detail.direction === 'low' ? 'low' : 'high'}`;
  if (item.metric === 'stock_variance')
    return `${base}.${item.detail.overStock === 1 ? 'over' : 'share'}`;
  return base;
}

/** Interpolation params for the sentence: Money fields as Rupiah, everything else as-is. */
export function detailParams(item: AnomalyItem): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(item.detail)) {
    if (v === null || v === undefined) {
      out[k] = '—';
    } else if (MONEY_DETAIL_KEYS.has(k) && typeof v === 'string') {
      out[k] = formatMoney(v as Money);
    } else {
      out[k] = v;
    }
  }
  out.actual = formatMeasure(item, item.actual);
  out.expected = formatMeasure(item, item.expected);
  return out;
}

/** An `expected`/`actual` value in the unit its finding is measured in. */
export function formatMeasure(item: Pick<AnomalyItem, 'unit'>, value: string | null): string {
  if (value === null) return '—';
  switch (item.unit) {
    case 'idr':
      return formatMoney(value as Money);
    case 'qty':
      return formatQty(value as Qty);
    case 'pct':
      return `${formatNumber(Number(value), 1)}%`;
    default:
      return formatNumber(Number(value), 0);
  }
}

/** One drill-down cell, rendered by its column's declared type. */
export function formatDrillCell(col: DrillColumn, value: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (col.type) {
    case 'money':
      return formatMoney(String(value) as Money);
    case 'qty':
      return formatQty(String(value) as Qty);
    case 'pct':
      return `${formatNumber(Number(value), 1)}%`;
    case 'datetime': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime())
        ? String(value)
        : d.toLocaleString('id-ID', { timeZone: 'Asia/Makassar', hour12: false });
    }
    default:
      return String(value);
  }
}

/** `severity` -> Badge variant. */
export function severityVariant(s: AnomalyItem['severity']): 'danger' | 'warning' | 'info' {
  return s === 'high' ? 'danger' : s === 'medium' ? 'warning' : 'info';
}
