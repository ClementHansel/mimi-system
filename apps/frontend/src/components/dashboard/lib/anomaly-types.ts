/**
 * Wire shapes for the dashboard "Anomali" panel — transcribed from
 * `apps/backend/src/modules/dashboard/anomalies/anomaly.types.ts`. Money and
 * quantities are decimal STRINGS, as everywhere else on the wire.
 */
import type { ISODate, UUID } from '@/lib/shared-types';

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
export type AnomalyUnit = 'idr' | 'qty' | 'pct' | 'days' | 'count';

export interface AnomalyItem {
  fingerprint: string;
  severity: AnomalySeverity;
  locationId: UUID | null;
  locationName: string | null;
  /** WITA calendar date, for a finding about one day. */
  date: ISODate | null;
  period: { from: ISODate | null; to: ISODate | null } | null;
  /** Which quantity `expected`/`actual` measure; translated as `dashboard.anomaly.metric.<metric>`. */
  metric: string;
  unit: AnomalyUnit;
  expected: string | null;
  actual: string | null;
  ratio: number | null;
  /** Named facts the panel's sentence is built from. */
  detail: Record<string, string | number | null>;
  /** Query parameters for the drill-down endpoint. */
  ref: Record<string, string>;
  link: string | null;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
}

export interface AnomalyDetectorResult {
  key: AnomalyDetectorKey;
  /** Findings still waiting for a look. */
  count: number;
  reviewedCount: number;
  total: number;
  truncated: boolean;
  notice: 'no_settlement_recorded' | null;
  failed: boolean;
  items: AnomalyItem[];
}

export interface AnomalyResponse {
  from: ISODate;
  to: ISODate;
  detectors: AnomalyDetectorResult[];
  openCount: number;
}

export interface DrillColumn {
  key: string;
  type: 'text' | 'money' | 'qty' | 'pct' | 'datetime' | 'date';
}

export interface DrillResult {
  columns: DrillColumn[];
  rows: Record<string, string | number | null>[];
}

export interface ThresholdField {
  detector: string;
  key: string;
  default: number;
  min: number;
  max: number;
  integer?: boolean;
}

export type AnomalyThresholds = Record<string, Record<string, number>>;

export interface ThresholdsResponse {
  thresholds: AnomalyThresholds;
  defaults: AnomalyThresholds;
  fields: ThresholdField[];
}

export interface ReviewResult {
  detector: AnomalyDetectorKey;
  fingerprint: string;
  reviewed: boolean;
  reviewedAt: string | null;
}
