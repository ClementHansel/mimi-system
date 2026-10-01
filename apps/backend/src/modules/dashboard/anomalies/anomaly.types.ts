import type { PoolClient } from 'pg';
import type { LocationScope } from '../../../common/scope/scope.service';
import type { AnomalyThresholds } from './anomaly-thresholds';

/** The seven detectors, in the order the panel lists them. */
export const ANOMALY_DETECTORS = [
  'sales_day_outlier',
  'product_qty_outlier',
  'usage_variance',
  'price_deviation',
  'payroll_outlier',
  'gl_sanity',
  'settlement_gap',
] as const;

export type AnomalyDetectorKey = (typeof ANOMALY_DETECTORS)[number];

export type AnomalySeverity = 'high' | 'medium' | 'low';

/** What `expected`/`actual` are measured in, so the panel formats them without guessing. */
export type AnomalyUnit = 'idr' | 'qty' | 'pct' | 'days' | 'count';

/**
 * What a detector returns. `locationName`, `reviewed*` are filled in by the
 * service, once, for every detector — a detector only knows its own SQL.
 */
export interface RawAnomalyItem {
  /** Stable identity of the finding — the review key. Must not depend on the window. */
  fingerprint: string;
  severity: AnomalySeverity;
  locationId: string | null;
  /** WITA calendar date, for a finding about one day. */
  date: string | null;
  /** For a finding about a stretch (an opname period, a payroll period). */
  period: { from: string | null; to: string | null } | null;
  /** Which quantity `expected`/`actual` measure — a key the panel translates. */
  metric: string;
  unit: AnomalyUnit;
  expected: string | null;
  actual: string | null;
  /** actual / expected (or the share, for share-based detectors); null when it has no meaning. */
  ratio: number | null;
  /** Named facts for the panel's sentence; values are never prose. */
  detail: Record<string, string | number | null>;
  /** Query parameters for the drill-down endpoint (the offending rows). */
  ref: Record<string, string>;
  /** A path in the app where the offending record can be opened, when one exists. */
  link: string | null;
}

export interface AnomalyItem extends RawAnomalyItem {
  locationName: string | null;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
}

export interface AnomalyDetectorResult {
  key: AnomalyDetectorKey;
  /** Findings still waiting for a look (what the badge counts). */
  count: number;
  reviewedCount: number;
  /** How many findings exist before the per-detector cap below. */
  total: number;
  truncated: boolean;
  /** A reason the detector had nothing to say, as a code the panel translates (not a finding). */
  notice: 'no_settlement_recorded' | null;
  /** The detector's query failed (logged server-side); the other detectors are unaffected. */
  failed: boolean;
  items: AnomalyItem[];
}

export interface AnomalyResponse {
  from: string;
  to: string;
  detectors: AnomalyDetectorResult[];
  /** Sum of `count` across detectors. */
  openCount: number;
}

export interface DetectorContext {
  client: PoolClient;
  scope: LocationScope;
  from: string;
  to: string;
  locationId: string | undefined;
  th: AnomalyThresholds;
}

export interface DetectorOutput {
  items: RawAnomalyItem[];
  notice?: AnomalyDetectorResult['notice'];
}

/** One drill-down column; `type` tells the panel how to render the cell. */
export interface DrillColumn {
  key: string;
  type: 'text' | 'money' | 'qty' | 'pct' | 'datetime' | 'date';
}

export interface DrillResult {
  columns: DrillColumn[];
  rows: Record<string, string | number | null>[];
}

/** The cap on findings shipped per detector; the rest are counted in `total`. */
export const MAX_ITEMS_PER_DETECTOR = 200;
