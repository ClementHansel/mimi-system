import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Pool } from 'pg';
import { ApprovalDocumentType } from '@mimi/shared';
import { actionsFrom } from '@mimi/shared';

/**
 * A DOCUMENT WAITING FOR A DECISION MUST HAVE A CHAIN TO DECIDE.
 *
 * ── THE REPORT THAT LED HERE ────────────────────────────────────────────────
 * "gagal approve cuti" (2026-09-04). Three sick-leave requests sat at
 * Menunggu on production, the screen offered Setujui and Tolak, and every
 * click failed. The cause was not the approval code: those three rows had NO
 * APPROVAL RECORD AT ALL, so `ApprovalService.approve` looked for a chain that
 * did not exist and answered 404 — which the panel then discarded in favour of
 * "Terjadi kesalahan".
 *
 * `database/seed.ts` inserts a pending leave request directly:
 *
 *     INSERT INTO leave_requests (..., status) SELECT ..., 'pending'
 *
 * No `approval_id`, no `approvals` row, no `approval_steps`. Every environment
 * therefore ships a document that LOOKS actionable and can never be actioned.
 * The client found it by doing the obvious thing with the demo data.
 *
 * It is not one row. On a seeded database three more tables ship the same dead
 * end — `waste_records`, `void_refunds` and `cash_variance_proposals` — and
 * they are precisely the three that `seed-gaps.ts` builds chains for every
 * other document but never lists.
 *
 * ── WHY THIS IS THE RIGHT PLACE TO CATCH IT ─────────────────────────────────
 * The invariant is not "the seed is correct" but "no document in a state that
 * offers a decision lacks the thing that records decisions". `actionsFrom()`
 * reads CONTRACTS.md §5, so the set of states that need a chain is derived
 * rather than listed here — a new status, or a rule moved from one state to
 * another, changes what this test demands without anybody editing it.
 *
 * It runs against the seeded database in CI, which is the same data every
 * demo, every e2e run and every client walkthrough uses. A landmine in the
 * fixtures is a landmine in front of the client.
 */

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

/**
 * Every table whose decisions run through `kernel/approvals`, with the document
 * type whose §5 rules govern it. The list is exactly the modules that call
 * `approvals.approve`/`.reject`.
 *
 * `payment_verifications` is deliberately ABSENT: verification is its own flow
 * and never calls the kernel, so its 167 pending rows legitimately have no
 * chain. Including it made this suite report 172 false alarms.
 */
const DOCUMENTS: ReadonlyArray<{ table: string; type: ApprovalDocumentType }> = [
  { table: 'leave_requests', type: ApprovalDocumentType.LEAVE_REQUEST },
  { table: 'employee_loans', type: ApprovalDocumentType.EMPLOYEE_LOAN },
  { table: 'stock_opname', type: ApprovalDocumentType.STOCK_OPNAME },
  { table: 'purchase_requests', type: ApprovalDocumentType.PURCHASE_REQUEST },
  { table: 'purchase_orders', type: ApprovalDocumentType.PURCHASE_ORDER },
  { table: 'replenishment_requests', type: ApprovalDocumentType.REPLENISHMENT_REQUEST },
  { table: 'returns', type: ApprovalDocumentType.RETURN },
  { table: 'waste_records', type: ApprovalDocumentType.WASTE },
  { table: 'void_refunds', type: ApprovalDocumentType.VOID_REFUND },
  { table: 'cash_variance_proposals', type: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL },
  { table: 'payroll_runs', type: ApprovalDocumentType.PAYROLL_RUN },
];

/** A state is "awaiting a decision" when §5 lets somebody approve or reject it. */
function awaitsDecision(type: ApprovalDocumentType, status: string): boolean {
  const actions = actionsFrom(type, status);
  return actions.includes('approve') || actions.includes('reject');
}

/**
 * Everything the seed and the migrations produced exists before this process
 * does. Specs that run alongside this one create documents, decide them and
 * delete the document in cleanup — leaving a chain behind — so an unqualified
 * orphan count is order-dependent and fails depending on which files ran
 * first. Anchoring on process start asks the question that actually matters:
 * did the FIXTURES ship an orphan? A hard assertion that flickers with test
 * order is worse than none, because it teaches people to ignore red.
 */
const PROCESS_START = new Date();

/**
 * Orphans are a HARD failure only where the database is known to be fresh.
 *
 * On CI the seed runs immediately before the suite, so anything orphaned after
 * `PROCESS_START` was orphaned by a spec in this very run and the cutoff above
 * excludes it — the question stays "did the FIXTURES ship an orphan". On a
 * long-lived dev database the same debris is left over from yesterday, predates
 * the cutoff, and cannot be told apart from a seeded orphan. There it prints a
 * warning instead of failing.
 */
const FRESH_DATABASE = process.env.CI === 'true' || process.env.CI === '1';

describe('documents awaiting a decision have an approval chain', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has no row that offers a decision with nothing to record it against', async () => {
    const offenders: string[] = [];

    for (const doc of DOCUMENTS) {
      // JOINED ON `approvals`, NOT on the document's own `approval_id`.
      //
      // That column is DENORMALISED and several services never write it:
      // `ReplenishmentService.submit` creates the approval and leaves the
      // column null, which is why 13 submitted replenishments looked chainless
      // while an e2e test had just walked one through both of its steps. The
      // first version of this suite keyed on the column and produced fifteen
      // false alarms — the chain is what `ApprovalService` looks up, so the
      // chain is what has to exist.
      const res = await pool.query<{ status: string; total: string; without: string }>(
        `SELECT d.status::text AS status,
                COUNT(*)::text AS total,
                COUNT(*) FILTER (
                  WHERE NOT EXISTS (
                    SELECT 1 FROM approvals a
                     WHERE a.document_type = $1 AND a.document_id = d.id
                  )
                )::text AS without
           FROM ${doc.table} d
          GROUP BY d.status`,
        [doc.type],
      );

      for (const row of res.rows) {
        if (!awaitsDecision(doc.type, row.status)) continue;
        if (Number(row.without) === 0) continue;
        offenders.push(
          `${doc.table} status '${row.status}': ${row.without} of ${row.total} rows have no approval ` +
            `chain — Setujui/Tolak is offered on these and will fail`,
        );
      }
    }

    expect(
      offenders,
      'a document in a decidable state with no chain is a dead end in the UI:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  }, 60_000);

  it('has no pending step beyond the one its chain has reached', async () => {
    // `ApprovalService.approve` INSERTS the next pending step as it advances,
    // and `approval_steps` is UNIQUE on (approval_id, step_no). So a chain that
    // already carries step 2 as `pending` cannot be advanced INTO step 2: the
    // first approval dies on 23505, which reaches the user as "Data ini sudah
    // ada." on a document they are simply trying to approve.
    //
    // `seed-gaps.ts` pre-created every configured step, so this had always been
    // true of seeded multi-step documents — replenishments, POs, opnames above
    // the threshold, void/refunds, kasbon. Found 2026-09-04 by driving the void
    // flow end to end: the supervisor's code minted fine and the cashier's
    // redemption failed. The seeder and migration 266 now write only the step
    // the document has actually reached.
    const res = await pool.query<{ document_type: string; n: string }>(
      `SELECT a.document_type, COUNT(*)::text AS n
         FROM approvals a
         JOIN approval_steps s ON s.approval_id = a.id
        WHERE a.state = 'pending'
          AND s.state = 'pending'
          AND a.current_step IS NOT NULL
          AND s.step_no > a.current_step
        GROUP BY a.document_type`,
    );

    const offenders = res.rows.map(
      (r) =>
        `${r.document_type}: ${r.n} step rows sit beyond current_step — approving these ` +
        `will fail with a duplicate key`,
    );
    expect(offenders, offenders.join('; ')).toEqual([]);
  }, 60_000);

  it('has no chain pointing at a document that no longer exists', async () => {
    // THE MIRROR OF THE INVARIANT ABOVE, and it bites just as hard. A local
    // database had 106 chains for `employee_loan` documents that had been
    // deleted, 53 of them still `pending`. Loans carry no location, and
    // `findPendingCandidates` admits `location_id IS NULL` for everyone, so
    // every one of those phantoms appeared in EVERY approver's inbox — and
    // pushed real work off the first page, which is how two unrelated tests
    // started failing.
    //
    // `approvals.document_id` cannot be a foreign key: it points at one of a
    // dozen tables depending on `document_type`. That is exactly why it needs
    // checking here.
    const orphans: string[] = [];
    for (const doc of DOCUMENTS) {
      const res = await pool.query<{ n: string; pending: string }>(
        `SELECT COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE a.state = 'pending')::text AS pending
           FROM approvals a
          WHERE a.document_type = $1
            AND a.requested_at < $2
            AND NOT EXISTS (SELECT 1 FROM ${doc.table} d WHERE d.id = a.document_id)`,
        [doc.type, PROCESS_START],
      );
      const row = res.rows[0]!;
      if (Number(row.n) > 0) {
        orphans.push(
          `${doc.type}: ${row.n} chains reference a missing ${doc.table} row, ` +
            `${row.pending} of them still pending (a pending one sits in every ` +
            `eligible approver's inbox; a settled one is dead weight and breaks ` +
            `any lookup that starts from the chain)`,
        );
      }
    }
    if (orphans.length > 0 && !FRESH_DATABASE) {
      console.warn(
        '[approval-chains] orphan chains present (NOT failed: this database is not freshly ' +
          'seeded, so these are probably debris from an earlier local run):' +
          orphans.join('; '),
      );
      return;
    }

    expect(orphans, 'chains for documents that do not exist: ' + orphans.join('; ')).toEqual([]);
  }, 60_000);

  it('every approval_id points at an approval that exists', async () => {
    // The denormalised column, where a service does set it, must at least point
    // at something real. A dangling id fails in the same place as a missing
    // chain, and a nullable FK written by hand does not stop it.
    const dangling: string[] = [];
    for (const doc of DOCUMENTS) {
      const res = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM ${doc.table} d
          WHERE d.approval_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = d.approval_id)`,
      );
      if (Number(res.rows[0]!.n) > 0) {
        dangling.push(`${doc.table}: ${res.rows[0]!.n} rows reference a missing approval`);
      }
    }
    expect(dangling, dangling.join('\n  ')).toEqual([]);
  }, 60_000);
});
