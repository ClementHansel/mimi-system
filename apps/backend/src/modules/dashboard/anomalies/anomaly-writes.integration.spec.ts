import { describe, it, expect, afterAll } from 'vitest';
import { can, RoleKey } from '@mimi/shared';
import { AnomalyService } from './anomaly.service';
import { closePool, ownerQuery, runAsRequestCommitting } from '../test-support/live-db';

/**
 * The two writes behind the Anomali panel — marking a finding reviewed, and
 * saving thresholds — against a real database, on COMMITTED transactions.
 *
 * The repo's recurring trap is a handler that writes on the request's client
 * and never commits: `RlsCleanupInterceptor` rolls the request back, the
 * endpoint answers 200 and nothing is saved, and a unit test against a mock
 * client cannot see it. So every assertion about persistence here reads the
 * row back on a DIFFERENT connection (`ownerQuery`) after the writer's
 * transaction has ended, and the spec cleans up after itself because a
 * committed row outlives the test.
 */
const svc = new AnomalyService();
const FP = 'sales_day_outlier:ZZANOM-WRITES:2099-01-01';

async function ids(): Promise<{ owner: string; outletA: string; outletB: string }> {
  const owner = (
    await ownerQuery<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'owner' AND u.is_active LIMIT 1`,
    )
  )[0]!.id;
  const outlets = await ownerQuery<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' AND is_active ORDER BY code LIMIT 2`,
  );
  return { owner, outletA: outlets[0]!.id, outletB: outlets[1]!.id };
}

const savedReviews = () =>
  ownerQuery<{ detector: string; fingerprint: string; reviewed_by: string; note: string | null }>(
    `SELECT detector, fingerprint, reviewed_by, note FROM anomaly_reviews WHERE fingerprint = $1`,
    [FP],
  );

describe('Anomali writes (integration, live Postgres, committed)', () => {
  afterAll(async () => {
    await ownerQuery(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
    await closePool();
  });

  it('marking a finding reviewed is COMMITTED — visible on another connection after the request ends', async () => {
    const { owner, outletA } = await ids();
    await ownerQuery(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
    try {
      const res = await runAsRequestCommitting(
        { role: RoleKey.OWNER, userId: owner, locationIds: [] },
        (client) =>
          svc.review(client, owner, {
            detector: 'sales_day_outlier',
            fingerprint: FP,
            locationId: outletA,
            note: 'dicek, memang ada acara',
          }),
      );
      expect(res.reviewed).toBe(true);

      const rows = await savedReviews();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reviewed_by).toBe(owner);
      expect(rows[0]!.note).toBe('dicek, memang ada acara');

      // Re-reviewing is an upsert on (detector, fingerprint), not a second row.
      await runAsRequestCommitting({ role: RoleKey.OWNER, userId: owner, locationIds: [] }, (c) =>
        svc.review(c, owner, {
          detector: 'sales_day_outlier',
          fingerprint: FP,
          locationId: outletA,
          note: 'lagi',
        }),
      );
      const again = await savedReviews();
      expect(again).toHaveLength(1);
      expect(again[0]!.note).toBe('lagi');

      // And it can be taken back.
      const undone = await runAsRequestCommitting(
        { role: RoleKey.OWNER, userId: owner, locationIds: [] },
        (c) =>
          svc.review(c, owner, { detector: 'sales_day_outlier', fingerprint: FP, reviewed: false }),
      );
      expect(undone.reviewed).toBe(false);
      expect(await savedReviews()).toHaveLength(0);
    } finally {
      await ownerQuery(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
    }
  });

  it("a branch-scoped manager cannot review another branch's finding, nor a company-level one (RLS)", async () => {
    const { owner, outletA, outletB } = await ids();
    try {
      await expect(
        runAsRequestCommitting(
          { role: RoleKey.MANAGER, userId: owner, locationIds: [outletB] },
          (c) =>
            svc.review(c, owner, {
              detector: 'sales_day_outlier',
              fingerprint: FP,
              locationId: outletA,
            }),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runAsRequestCommitting(
          { role: RoleKey.MANAGER, userId: owner, locationIds: [outletB] },
          (c) => svc.review(c, owner, { detector: 'gl_sanity', fingerprint: FP, locationId: null }),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // ...but their own branch is fine.
      await runAsRequestCommitting(
        { role: RoleKey.MANAGER, userId: owner, locationIds: [outletB] },
        (c) =>
          svc.review(c, owner, {
            detector: 'sales_day_outlier',
            fingerprint: FP,
            locationId: outletB,
          }),
      );
      expect(await savedReviews()).toHaveLength(1);
    } finally {
      await ownerQuery(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
    }
  });

  it('a role below manager cannot write a review even for their own outlet (RLS role gate)', async () => {
    const { owner, outletA } = await ids();
    await expect(
      runAsRequestCommitting(
        { role: RoleKey.SUPERVISOR, userId: owner, locationIds: [outletA] },
        (c) =>
          svc.review(c, owner, {
            detector: 'sales_day_outlier',
            fingerprint: FP,
            locationId: outletA,
          }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await savedReviews()).toHaveLength(0);
  });

  it('dashboard.view (the key every Anomali read and the review ride on) is owner/manager only', () => {
    expect(can(RoleKey.OWNER, 'dashboard.view')).toBe(true);
    expect(can(RoleKey.MANAGER, 'dashboard.view')).toBe(true);
    expect(can(RoleKey.SUPERVISOR, 'dashboard.view')).toBe(false);
    expect(can(RoleKey.KASIR, 'dashboard.view')).toBe(false);
  });

  // ── thresholds ─────────────────────────────────────────────────────────────

  it('thresholds: the owner saves (committed), a manager is refused, a bad number is refused and nothing changes', async () => {
    const { owner } = await ids();
    const before = (
      await ownerQuery<{ value: unknown }>(
        `SELECT value FROM settings WHERE key = 'anomaly.thresholds'`,
      )
    )[0]!.value;
    try {
      // The owner, partial update: only one number.
      const saved = await runAsRequestCommitting(
        { role: RoleKey.OWNER, userId: owner, locationIds: [] },
        (c) =>
          svc.putThresholds(
            c,
            { sub: owner, roleKey: 'owner' },
            { sales_day_outlier: { hi: 4.5 } },
          ),
      );
      expect(saved.thresholds.sales_day_outlier.hi).toBe(4.5);
      expect(saved.thresholds.sales_day_outlier.lo).toBe(0.3); // untouched

      const row = (
        await ownerQuery<{
          value: { sales_day_outlier: { hi: number }; gl_sanity: { cashGrowthDays: number } };
        }>(`SELECT value FROM settings WHERE key = 'anomaly.thresholds'`)
      )[0]!.value;
      expect(row.sales_day_outlier.hi).toBe(4.5); // on a DIFFERENT connection: committed
      expect(row.gl_sanity.cashGrowthDays).toBe(7); // the other detectors were carried along

      // A manager holds settings.manage but may not change these.
      await expect(
        runAsRequestCommitting({ role: RoleKey.MANAGER, userId: owner, locationIds: [] }, (c) =>
          svc.putThresholds(
            c,
            { sub: owner, roleKey: 'manager' },
            { sales_day_outlier: { hi: 9 } },
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });

      // Out-of-range, unknown parameter, wrong type: all refused, naming the field.
      for (const bad of [
        { sales_day_outlier: { hi: 0.5 } },
        { sales_day_outlier: { nope: 1 } },
        { gl_sanity: { cashGrowthDays: 'seven' } },
        { gl_sanity: { cashGrowthDays: 7.5 } },
        { not_a_detector: { x: 1 } },
      ]) {
        await expect(
          runAsRequestCommitting({ role: RoleKey.OWNER, userId: owner, locationIds: [] }, (c) =>
            svc.putThresholds(c, { sub: owner, roleKey: 'owner' }, bad),
          ),
        ).rejects.toMatchObject({ status: 400 });
      }
      const after = (
        await ownerQuery<{ value: { sales_day_outlier: { hi: number } } }>(
          `SELECT value FROM settings WHERE key = 'anomaly.thresholds'`,
        )
      )[0]!.value;
      expect(after.sales_day_outlier.hi).toBe(4.5);

      // The reader reflects the saved value.
      const read = await runAsRequestCommitting(
        { role: RoleKey.OWNER, userId: owner, locationIds: [] },
        (c) => svc.getThresholds(c),
      );
      expect(read.thresholds.sales_day_outlier.hi).toBe(4.5);
      expect(read.defaults.sales_day_outlier.hi).toBe(3);
      expect(read.fields.length).toBeGreaterThan(10);
    } finally {
      await ownerQuery(`UPDATE settings SET value = $1::jsonb WHERE key = 'anomaly.thresholds'`, [
        JSON.stringify(before),
      ]);
    }
  });

  it('a damaged settings row never stops the panel from loading: bad values fall back to the defaults', async () => {
    const { owner } = await ids();
    const before = (
      await ownerQuery<{ value: unknown }>(
        `SELECT value FROM settings WHERE key = 'anomaly.thresholds'`,
      )
    )[0]!.value;
    try {
      await ownerQuery(`UPDATE settings SET value = $1::jsonb WHERE key = 'anomaly.thresholds'`, [
        JSON.stringify({
          sales_day_outlier: { hi: 'three', lo: -1 },
          usage_variance: 'oops',
          gl_sanity: { cashGrowthDays: 14 },
        }),
      ]);
      const read = await runAsRequestCommitting(
        { role: RoleKey.OWNER, userId: owner, locationIds: [] },
        (c) => svc.getThresholds(c),
      );
      expect(read.thresholds.sales_day_outlier.hi).toBe(3);
      expect(read.thresholds.sales_day_outlier.lo).toBe(0.3);
      expect(read.thresholds.usage_variance.variancePct).toBe(25);
      expect(read.thresholds.gl_sanity.cashGrowthDays).toBe(14); // the good value survives
    } finally {
      await ownerQuery(`UPDATE settings SET value = $1::jsonb WHERE key = 'anomaly.thresholds'`, [
        JSON.stringify(before),
      ]);
    }
  });
});
