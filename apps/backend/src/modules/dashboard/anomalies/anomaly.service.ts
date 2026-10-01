import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_FORBIDDEN, ERR_VALIDATION } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { assertLocationInScope } from '../scope.util';
import { withWrite } from '../db-tx';
import {
  SETTINGS_KEY_ANOMALY_THRESHOLDS,
  THRESHOLD_FIELDS,
  defaultThresholds,
  loadThresholds,
  mergeThresholds,
  validateThresholdInput,
  type AnomalyThresholds,
  type ThresholdField,
} from './anomaly-thresholds';
import {
  ANOMALY_DETECTORS,
  MAX_ITEMS_PER_DETECTOR,
  type AnomalyDetectorKey,
  type AnomalyDetectorResult,
  type AnomalyItem,
  type AnomalyResponse,
  type DetectorContext,
  type DetectorOutput,
  type DrillResult,
  type RawAnomalyItem,
} from './anomaly.types';
import { detectSalesDayOutliers } from './detectors/sales-day-outlier';
import { detectProductQtyOutliers } from './detectors/product-qty-outlier';
import { detectUsageVariance } from './detectors/usage-variance';
import { detectPriceDeviation } from './detectors/price-deviation';
import { detectPayrollOutliers } from './detectors/payroll-outlier';
import { detectGlSanity } from './detectors/gl-sanity';
import { detectSettlementGap } from './detectors/settlement-gap';
import { drillDown, type DrillQuery } from './drilldown';

const DETECTORS: Record<AnomalyDetectorKey, (ctx: DetectorContext) => Promise<DetectorOutput>> = {
  sales_day_outlier: detectSalesDayOutliers,
  product_qty_outlier: detectProductQtyOutliers,
  usage_variance: detectUsageVariance,
  price_deviation: detectPriceDeviation,
  payroll_outlier: detectPayrollOutliers,
  gl_sanity: detectGlSanity,
  settlement_gap: detectSettlementGap,
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Who may change the thresholds. `settings.manage` also admits a manager; the owner asked for this to be the owner's call alone. */
const THRESHOLD_ROLES = new Set(['owner', 'superadmin']);

export interface ThresholdsResponse {
  thresholds: AnomalyThresholds;
  defaults: AnomalyThresholds;
  fields: readonly ThresholdField[];
}

export interface ReviewInput {
  detector: AnomalyDetectorKey;
  fingerprint: string;
  locationId?: string | null;
  note?: string | null;
  /** `false` takes the review back, so the finding shows again. */
  reviewed?: boolean;
}

export interface ReviewResult {
  detector: AnomalyDetectorKey;
  fingerprint: string;
  reviewed: boolean;
  reviewedAt: string | null;
}

interface ReviewRow {
  detector: string;
  fingerprint: string;
  reviewed_at: Date;
  note: string | null;
  reviewed_by: string;
}

/**
 * The dashboard "Anomali" panel — data anomalies the owner's spreadsheets
 * never flagged, found by SQL over the live tables and scoped exactly like
 * the other dashboard services (`scopeClause` / `assertLocationInScope`).
 *
 * Each detector runs under its own SAVEPOINT. One bad query (a table a
 * deployment lacks, a plan that times out) must not abort the transaction the
 * other six are running in — Postgres refuses every later statement in an
 * aborted transaction — so a failed detector is reported as `failed` and the
 * rest still answer.
 */
@Injectable()
export class AnomalyService {
  private readonly logger = new Logger(AnomalyService.name);

  async getAnomalies(
    client: PoolClient,
    scope: LocationScope,
    from: string,
    to: string,
    locationId: string | undefined,
    includeReviewed: boolean,
  ): Promise<AnomalyResponse> {
    assertLocationInScope(scope, locationId);
    const th = await loadThresholds(client);
    const ctx: DetectorContext = { client, scope, from, to, locationId, th };

    // These queries are one-shot aggregates over a window, not a hot loop: JIT
    // compilation would cost more than it saves (see overview.service.ts).
    await client.query('SET LOCAL jit = off');

    const raw = new Map<AnomalyDetectorKey, DetectorOutput | null>();
    for (const key of ANOMALY_DETECTORS) {
      raw.set(key, await this.runDetector(client, key, ctx));
    }

    const [names, reviews] = await Promise.all([
      this.locationNames(client),
      this.reviewsFor(client, raw),
    ]);
    const reviewers = await this.reviewerNames(client, [
      ...new Set([...reviews.values()].map((r) => r.reviewed_by)),
    ]);

    const detectors: AnomalyDetectorResult[] = ANOMALY_DETECTORS.map((key) => {
      const out = raw.get(key);
      if (out === null || out === undefined) {
        return {
          key,
          count: 0,
          reviewedCount: 0,
          total: 0,
          truncated: false,
          notice: null,
          failed: true,
          items: [],
        };
      }
      const decorated: AnomalyItem[] = out.items.map((i) =>
        decorate(i, key, names, reviews, reviewers),
      );
      // Stable sort: severity first, the detector's own ordering within it.
      decorated.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
      const open = decorated.filter((i) => !i.reviewed);
      const reviewedCount = decorated.length - open.length;
      const eligible = includeReviewed ? decorated : open;
      return {
        key,
        count: open.length,
        reviewedCount,
        total: eligible.length,
        truncated: eligible.length > MAX_ITEMS_PER_DETECTOR,
        notice: out.notice ?? null,
        failed: false,
        items: eligible.slice(0, MAX_ITEMS_PER_DETECTOR),
      };
    });

    return { from, to, detectors, openCount: detectors.reduce((n, d) => n + d.count, 0) };
  }

  /** Runs one detector in a savepoint; `null` means it failed (already logged). */
  private async runDetector(
    client: PoolClient,
    key: AnomalyDetectorKey,
    ctx: DetectorContext,
  ): Promise<DetectorOutput | null> {
    await client.query(`SAVEPOINT anomaly_${key}`);
    try {
      const out = await DETECTORS[key](ctx);
      await client.query(`RELEASE SAVEPOINT anomaly_${key}`);
      return out;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT anomaly_${key}`);
      this.logger.error(
        `anomaly detector ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async locationNames(client: PoolClient): Promise<Map<string, string>> {
    const res = await client.query<{ id: string; name: string }>(`SELECT id, name FROM locations`);
    return new Map(res.rows.map((r) => [r.id, r.name]));
  }

  /** The reviews matching any fingerprint a detector produced, keyed `detector|fingerprint`. */
  private async reviewsFor(
    client: PoolClient,
    raw: Map<AnomalyDetectorKey, DetectorOutput | null>,
  ): Promise<Map<string, ReviewRow>> {
    const detectors: string[] = [];
    const fingerprints: string[] = [];
    for (const [key, out] of raw) {
      for (const i of out?.items ?? []) {
        detectors.push(key);
        fingerprints.push(i.fingerprint);
      }
    }
    const map = new Map<string, ReviewRow>();
    if (fingerprints.length === 0) return map;
    const res = await client.query<ReviewRow>(
      `SELECT r.detector, r.fingerprint, r.reviewed_at, r.note, r.reviewed_by
         FROM anomaly_reviews r
        WHERE r.detector = ANY($1::text[]) AND r.fingerprint = ANY($2::text[])`,
      [[...new Set(detectors)], fingerprints],
    );
    for (const r of res.rows) map.set(`${r.detector}|${r.fingerprint}`, r);
    return map;
  }

  /** `users` is readable only for oneself outside the central roles; `app_user_display` (migration 212) is the sanctioned name lookup. */
  private async reviewerNames(client: PoolClient, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const res = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM app_user_display($1::uuid[])`,
      [ids],
    );
    return new Map(res.rows.map((r) => [r.id, r.name]));
  }

  async drillDown(client: PoolClient, scope: LocationScope, q: DrillQuery): Promise<DrillResult> {
    return drillDown(client, scope, q);
  }

  /**
   * Marks a finding reviewed (or takes that back). Wrapped in `withWrite`:
   * the request client is rolled back by `RlsCleanupInterceptor` after every
   * request, so without the COMMIT this would answer 200 and save nothing.
   * RLS (`anomaly_reviews_*`, migration 271) is what confines the location:
   * a manager scoped to some branches cannot review another branch's finding.
   */
  async review(client: PoolClient, userId: string, input: ReviewInput): Promise<ReviewResult> {
    const wantReviewed = input.reviewed !== false;
    return withWrite(client, async () => {
      if (!wantReviewed) {
        await client.query(`DELETE FROM anomaly_reviews WHERE detector = $1 AND fingerprint = $2`, [
          input.detector,
          input.fingerprint,
        ]);
        return {
          detector: input.detector,
          fingerprint: input.fingerprint,
          reviewed: false,
          reviewedAt: null,
        };
      }
      const res = await client.query<{ reviewed_at: Date }>(
        `INSERT INTO anomaly_reviews (detector, fingerprint, location_id, reviewed_by, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (detector, fingerprint)
         DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW(), note = EXCLUDED.note
         RETURNING reviewed_at`,
        [input.detector, input.fingerprint, input.locationId ?? null, userId, input.note ?? null],
      );
      return {
        detector: input.detector,
        fingerprint: input.fingerprint,
        reviewed: true,
        reviewedAt: res.rows[0]!.reviewed_at.toISOString(),
      };
    });
  }

  async getThresholds(client: PoolClient): Promise<ThresholdsResponse> {
    return {
      thresholds: await loadThresholds(client),
      defaults: defaultThresholds(),
      fields: THRESHOLD_FIELDS,
    };
  }

  /**
   * Owner-only. The submitted object may be partial (one detector, one
   * parameter); it is validated strictly (an out-of-range number is refused,
   * not silently replaced) and merged over what is stored, then the whole
   * object is written back. The error CODE is the user-facing sentence —
   * `details.fields` names which numbers were refused.
   */
  async putThresholds(
    client: PoolClient,
    user: { sub: string; roleKey: string },
    input: unknown,
  ): Promise<ThresholdsResponse> {
    if (!THRESHOLD_ROLES.has(user.roleKey)) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'Only the owner may change anomaly thresholds',
      });
    }
    const bad = validateThresholdInput(input);
    if (bad.length > 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'Invalid anomaly thresholds',
        details: { fields: bad },
      });
    }
    return withWrite(client, async () => {
      const current = await loadThresholds(client);
      const next = mergeThresholds(mergeDeep(current, input));
      await client.query(
        `INSERT INTO settings (key, value, description, updated_by, updated_at)
         VALUES ($1, $2::jsonb, 'Dashboard Anomali panel: per-detector thresholds', $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [SETTINGS_KEY_ANOMALY_THRESHOLDS, JSON.stringify(next), user.sub],
      );
      return { thresholds: next, defaults: defaultThresholds(), fields: THRESHOLD_FIELDS };
    });
  }
}

function mergeDeep(base: AnomalyThresholds, patch: unknown): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [d, group] of Object.entries(base)) out[d] = { ...(group as object) };
  for (const [d, group] of Object.entries(patch as Record<string, Record<string, unknown>>)) {
    out[d] = { ...(out[d] ?? {}), ...group };
  }
  return out;
}

function decorate(
  i: RawAnomalyItem,
  detector: AnomalyDetectorKey,
  names: Map<string, string>,
  reviews: Map<string, ReviewRow>,
  reviewers: Map<string, string>,
): AnomalyItem {
  const r = reviews.get(`${detector}|${i.fingerprint}`);
  return {
    ...i,
    locationName: i.locationId ? (names.get(i.locationId) ?? null) : null,
    reviewed: r !== undefined,
    reviewedAt: r ? r.reviewed_at.toISOString() : null,
    reviewedByName: r ? (reviewers.get(r.reviewed_by) ?? null) : null,
    reviewNote: r?.note ?? null,
  };
}
