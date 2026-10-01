import type { PoolClient } from 'pg';

/**
 * Per-detector parameters for the dashboard "Anomali" panel, stored as one
 * JSON `settings` row (`anomaly.thresholds`, migration 271).
 *
 * `THRESHOLD_FIELDS` is the single declaration of what may be configured:
 * its `default` is what the code falls back to, its `min`/`max` is what a
 * saved value is validated against, and the panel's thresholds dialog is
 * generated from it (served by `GET /dashboard/anomalies/thresholds`). A new
 * parameter is one line here.
 */
export interface ThresholdField {
  detector: string;
  key: string;
  default: number;
  min: number;
  max: number;
  /** Integer-only parameters (day counts, row counts). */
  integer?: boolean;
}

export const THRESHOLD_FIELDS: readonly ThresholdField[] = [
  // An outlet-day's revenue vs the median of that outlet's previous N days.
  { detector: 'sales_day_outlier', key: 'hi', default: 3, min: 1.1, max: 1000 },
  { detector: 'sales_day_outlier', key: 'lo', default: 0.3, min: 0.01, max: 0.99 },
  {
    detector: 'sales_day_outlier',
    key: 'baselineDays',
    default: 28,
    min: 7,
    max: 90,
    integer: true,
  },
  {
    detector: 'sales_day_outlier',
    key: 'minHistoryDays',
    default: 5,
    min: 2,
    max: 28,
    integer: true,
  },

  // A product's one-day qty at one outlet vs its median day.
  { detector: 'product_qty_outlier', key: 'multiple', default: 5, min: 1.1, max: 1000 },
  { detector: 'product_qty_outlier', key: 'minQty', default: 50, min: 1, max: 1_000_000 },

  // Recipe-theoretical vs actual usage between two stock counts.
  { detector: 'usage_variance', key: 'variancePct', default: 25, min: 1, max: 100 },
  { detector: 'usage_variance', key: 'minValue', default: 500_000, min: 0, max: 1_000_000_000 },
  { detector: 'usage_variance', key: 'periodPctOfSales', default: 5, min: 0.1, max: 100 },

  // Share of an outlet's lines of one product sold off the current price.
  { detector: 'price_deviation', key: 'sharePct', default: 10, min: 1, max: 100 },
  { detector: 'price_deviation', key: 'minLines', default: 3, min: 1, max: 10_000, integer: true },

  { detector: 'payroll_outlier', key: 'netBelowBasePct', default: 25, min: 1, max: 100 },
  { detector: 'payroll_outlier', key: 'deductionsAboveGrossPct', default: 50, min: 1, max: 100 },

  { detector: 'gl_sanity', key: 'cashGrowthDays', default: 7, min: 1, max: 365, integer: true },
  { detector: 'gl_sanity', key: 'minAbsBalance', default: 100_000, min: 0, max: 1_000_000_000 },

  // Card/transfer takings vs settlements recorded, per outlet-day.
  { detector: 'settlement_gap', key: 'gapPct', default: 20, min: 1, max: 100 },
  { detector: 'settlement_gap', key: 'minGapAmount', default: 100_000, min: 0, max: 1_000_000_000 },
];

export interface AnomalyThresholds {
  sales_day_outlier: { hi: number; lo: number; baselineDays: number; minHistoryDays: number };
  product_qty_outlier: { multiple: number; minQty: number };
  usage_variance: { variancePct: number; minValue: number; periodPctOfSales: number };
  price_deviation: { sharePct: number; minLines: number };
  payroll_outlier: { netBelowBasePct: number; deductionsAboveGrossPct: number };
  gl_sanity: { cashGrowthDays: number; minAbsBalance: number };
  settlement_gap: { gapPct: number; minGapAmount: number };
}

export const SETTINGS_KEY_ANOMALY_THRESHOLDS = 'anomaly.thresholds';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function acceptable(field: ThresholdField, v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= field.min &&
    v <= field.max &&
    (!field.integer || Number.isInteger(v))
  );
}

/** The in-code defaults, in the shape the detectors read. */
export function defaultThresholds(): AnomalyThresholds {
  return mergeThresholds(null);
}

/**
 * Overlays a stored value on the defaults. NEVER throws and never trusts the
 * row: anything that is not a finite number inside the field's range (a
 * hand-edited string, a negative multiplier, a missing detector) is dropped
 * and the default stands, so a bad row cannot stop the panel from loading —
 * and cannot silently turn a detector off by making its threshold nonsense.
 */
export function mergeThresholds(stored: unknown): AnomalyThresholds {
  const out: Record<string, Record<string, number>> = {};
  const root = isRecord(stored) ? stored : {};
  for (const f of THRESHOLD_FIELDS) {
    const group = isRecord(root[f.detector]) ? (root[f.detector] as Record<string, unknown>) : {};
    const v = group[f.key];
    (out[f.detector] ??= {})[f.key] = acceptable(f, v) ? v : f.default;
  }
  return out as unknown as AnomalyThresholds;
}

/**
 * Validates a thresholds object submitted by the owner. Unlike
 * `mergeThresholds`, an out-of-range value is an ERROR here, not a fallback —
 * the owner must be told their number was refused rather than have it
 * quietly replaced. Returns the offending `detector.key` paths.
 */
export function validateThresholdInput(input: unknown): string[] {
  if (!isRecord(input)) return ['thresholds'];
  const bad: string[] = [];
  const known = new Set(THRESHOLD_FIELDS.map((f) => `${f.detector}.${f.key}`));
  for (const [detector, group] of Object.entries(input)) {
    if (!isRecord(group)) {
      bad.push(detector);
      continue;
    }
    for (const [key, v] of Object.entries(group)) {
      const field = THRESHOLD_FIELDS.find((f) => f.detector === detector && f.key === key);
      if (!known.has(`${detector}.${key}`) || !field || !acceptable(field, v)) {
        bad.push(`${detector}.${key}`);
      }
    }
  }
  return bad;
}

/** Reads the stored row; any failure (missing row, bad JSON) means "use the defaults". */
export async function loadThresholds(client: PoolClient): Promise<AnomalyThresholds> {
  try {
    const res = await client.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = $1`,
      [SETTINGS_KEY_ANOMALY_THRESHOLDS],
    );
    return mergeThresholds(res.rows[0]?.value);
  } catch {
    return defaultThresholds();
  }
}
