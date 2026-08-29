/**
 * MA-174 — post the GL entries the seeded operating history never wrote.
 *
 * ## The problem this fixes
 *
 * `seed-history.ts`, `seed-extended.ts` and `seed-gaps.ts` generate terminal
 * business documents — dispatched Surat Jalan, completed drops, adjusted stock
 * opnames — by INSERTing them directly. That is the right call for a seed:
 * driving them through the real services would need an RLS session per actor
 * and would take minutes instead of seconds.
 *
 * But those files also insert the matching `stock_movements`, each carrying a
 * real `unit_cost`. So the seeded history had inventory moving and value
 * standing still. That is not a cosmetic reporting gap:
 *
 *   - `gl-coverage` reports every one of those documents as unposted, so the
 *     one report whose job is to find real posting holes is permanently red
 *     and therefore ignored;
 *   - `1100` / `1110` / `1120` do not reconcile against `stock_balances`, so
 *     the finance screens disagree with the stock screens on a box someone is
 *     using to demonstrate the system.
 *
 * Bypassing the services skipped `EventBus.publish('journal.action', …)`, which
 * is what would have posted. Nothing was wrong with the services — they were
 * never called.
 *
 * ## Why a separate backfill rather than edits in each seed file
 *
 * Three files create these documents and more may later. Patching each one
 * spreads posting logic across all of them and guarantees the next one forgets.
 * This runs last, asks the database what is terminal-but-unposted, and fixes
 * whatever it finds — so a new seed file is covered for free.
 *
 * ## Where the amounts come from — and a defect found while deciding
 *
 * Each amount is `Σ(qty × cost)` over the DOCUMENT'S OWN LINES: `sj_lines` for
 * deliveries, `stock_opname_lines` for adjustments. That is what the posting
 * rules themselves specify — JGUD-03 reads "Σ sj_line.qty × items.avg_cost at
 * dispatch", JOUT-06 reads "|qty_delta| × unit_cost".
 *
 * My first attempt valued these from `stock_movements` instead, on the
 * reasoning that the real services post from exactly the ledger movement they
 * just made. That reasoning is right for the services and wrong here, because
 * of something worth recording:
 *
 *   **The seeded `stock_movements` have dangling `ref_id`s.** Measured
 *   2026-08-29 on a freshly seeded database: of 130 movements with
 *   `ref_type='sj_drop'`, **zero** join to a real `sj_drops` row; of 64 with
 *   `ref_type='stock_adjustment'`, **zero** join to a `stock_opname` or
 *   `stock_opname_lines` row. The movements reference documents that do not
 *   exist. Separately, `seed.ts`'s single in-flight Surat Jalan has no
 *   movements at all.
 *
 * So valuing from movements would have posted from rows that point nowhere, or
 * posted nothing. The document lines are both the contractually-named source
 * and the only trustworthy one here.
 *
 * That dangling-reference defect is NOT fixed by this script and deserves its
 * own ticket: it makes `stock_movements` unjoinable to the documents that
 * caused it, which will mislead anyone auditing stock on the demo box.
 *
 * Accounts come from `posting-rules.ts` in `@mimi/shared` — the same table the
 * posting engine reads. That package is zero-I/O rule DATA, so this is reading
 * the contract rather than reimplementing the engine.
 *
 * ## When this runs
 *
 * Chained onto `pnpm db:seed`, so the ordinary path leaves a coherent ledger.
 * The OTHER generators — `seed-history.ts`, `seed-extended.ts`, `seed-gaps.ts`
 * — are invoked separately, so run `pnpm db:seed:journal` after any of them
 * too. It is safe to run at any time and does nothing when there is nothing to
 * post.
 *
 * ## Idempotent twice over
 *
 * The query only selects documents with no entry, and `journal_entries` carries
 * `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` (migration
 * 092). Re-running is a no-op.
 */
import pg from 'pg';
import { loadRepoEnv, migrationConnectionString, describeConnection } from './db-connection';

/** One document that should have posted and did not. */
interface UnpostedDoc {
  id: string;
  location_id: string;
  entry_date: string;
  /** `Σ(qty × cost)` over this document's own lines — see the header on why not movements. */
  amount: string;
  /** Only meaningful for stock adjustments — 'shortage' | 'overage'. */
  direction: string | null;
  /** `true` when the location is a warehouse, which selects the JGUD rule over the JOUT one. */
  is_warehouse: boolean;
}

interface Backfill {
  refType: string;
  label: string;
  /**
   * Terminal documents with no journal entry, joined to their own LINES for
   * the amount.
   *
   * `HAVING SUM(...) > 0` matters: a document whose movements net to zero has
   * nothing to post, and a zero-value entry would be noise in the ledger that
   * still satisfies every "is it posted?" check.
   */
  sql: string;
  /** Chooses the event type and the debit/credit pair for one document. */
  route(doc: UnpostedDoc): { eventType: string; debit: string; credit: string; memo: string };
}

const BACKFILLS: readonly Backfill[] = [
  {
    refType: 'surat_jalan',
    label: 'dispatched Surat Jalan (JGUD-03)',
    // Valued from `sj_lines.qty × items.avg_cost`, which is exactly what
    // JGUD-03's `amountSource` names: "Σ sj_line.qty × items.avg_cost at
    // dispatch". Dispatch posts what was SENT, so this uses `qty` — the
    // receiving side posts `qty_received` separately as JOUT-01, and any
    // difference between them is the shortfall JOUT-01's second rule books.
    sql: `
      SELECT d.id, d.origin_location_id AS location_id,
             d.dispatched_at::date::text AS entry_date,
             COALESCE(SUM(sl.qty * i.avg_cost), 0)::numeric(18,2)::text AS amount,
             NULL::text AS direction, TRUE AS is_warehouse
        FROM surat_jalan d
        JOIN sj_lines sl ON sl.sj_id = d.id
        JOIN items i ON i.id = sl.item_id
       WHERE d.status IN ('in_transit', 'completed')
         AND d.dispatched_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries j
                          WHERE j.ref_type = 'surat_jalan' AND j.ref_id = d.id)
       GROUP BY d.id, d.origin_location_id, d.dispatched_at
      HAVING COALESCE(SUM(sl.qty * i.avg_cost), 0) > 0`,
    route: () => ({
      eventType: 'gudang_goods_out_to_outlet',
      debit: '1120',
      credit: '1100',
      memo: 'Barang keluar ke outlet (backfill riwayat seed)',
    }),
  },
  {
    refType: 'sj_drops',
    label: 'received drops (JOUT-01)',
    // `qty_received`, not `qty` — JOUT-01's base rule is "Σ line.qty_received
    // × cost". A drop that arrived short must post what ARRIVED, or outlet
    // stock is credited with goods nobody unloaded.
    //
    // COALESCE to 0 rather than skipping a null: a completed drop with a null
    // `qty_received` on some line contributes nothing from that line, which is
    // right, and the HAVING below then drops any document that adds up to
    // nothing at all.
    sql: `
      SELECT d.id, d.location_id,
             d.received_at::date::text AS entry_date,
             COALESCE(SUM(COALESCE(sl.qty_received, 0) * i.avg_cost), 0)::numeric(18,2)::text AS amount,
             NULL::text AS direction, FALSE AS is_warehouse
        FROM sj_drops d
        JOIN sj_lines sl ON sl.drop_id = d.id
        JOIN items i ON i.id = sl.item_id
       WHERE d.status IN ('completed', 'completed_discrepancy')
         AND d.received_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries j
                          WHERE j.ref_type = 'sj_drops' AND j.ref_id = d.id)
       GROUP BY d.id, d.location_id, d.received_at
      HAVING COALESCE(SUM(COALESCE(sl.qty_received, 0) * i.avg_cost), 0) > 0`,
    route: () => ({
      eventType: 'outlet_goods_in_from_warehouse',
      debit: '1110',
      credit: '1120',
      memo: 'Barang masuk dari gudang (backfill riwayat seed)',
    }),
  },
  {
    refType: 'stock_adjustment',
    label: 'adjusted stock opnames (JOUT-06 / JGUD-06)',
    // NOT derived from `stock_movements`, unlike the two above, and the reason
    // is a real defect in the seeded data rather than a preference: the seeded
    // `stock_movements` rows with `ref_type='stock_adjustment'` carry
    // **dangling `ref_id`s**. Measured 2026-08-29 — 64 such movements, and
    // NONE of their `ref_id`s match a `stock_opname` or a
    // `stock_opname_lines` row. There is simply no link from those movements
    // back to the document that supposedly caused them.
    //
    // So the amount comes from the opname's OWN lines, which is where the
    // variance actually lives and is what the posting rule names anyway
    // (`|qty_delta| × unit_cost`). That is also the more truthful source: the
    // lines are what a counter actually recorded.
    //
    // The dangling movements are worth fixing in the seed separately — they
    // make `stock_movements` unjoinable to its own documents — but posting
    // from them would mean posting from data that references nothing.
    //
    // `diff_qty` sign is the direction: negative is a shortage (stock the count
    // could not find), positive an overage. The amount is the ABSOLUTE value —
    // a journal line is never negative; direction is expressed by which side of
    // the entry the value lands on.
    sql: `
      SELECT d.id, d.location_id,
             d.approved_at::date::text AS entry_date,
             ABS(COALESCE(SUM(sl.diff_qty * i.avg_cost), 0))::numeric(18,2)::text AS amount,
             CASE WHEN COALESCE(SUM(sl.diff_qty * i.avg_cost), 0) < 0
                  THEN 'shortage' ELSE 'overage' END AS direction,
             (l.type = 'warehouse') AS is_warehouse
        FROM stock_opname d
        JOIN locations l ON l.id = d.location_id
        JOIN stock_opname_lines sl ON sl.opname_id = d.id
        JOIN items i ON i.id = sl.item_id
       WHERE d.status = 'adjusted'
         AND d.approved_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries j
                          WHERE j.ref_type = 'stock_adjustment' AND j.ref_id = d.id)
       GROUP BY d.id, d.location_id, d.approved_at, l.type
      HAVING ABS(COALESCE(SUM(sl.diff_qty * i.avg_cost), 0)) > 0`,
    route: (doc) => {
      const shortage = doc.direction === 'shortage';
      if (doc.is_warehouse) {
        // JGUD-06 — no attributable arm at the warehouse.
        return shortage
          ? {
              eventType: 'gudang_stock_adjustment',
              debit: '6400',
              credit: '1100',
              memo: 'Selisih opname gudang (kurang)',
            }
          : {
              eventType: 'gudang_stock_adjustment',
              debit: '1100',
              credit: '4100',
              memo: 'Selisih opname gudang (lebih)',
            };
      }
      // JOUT-06. Seeded shortages are booked NON-attributable (6400) rather
      // than to a staff receivable (1210): attributing one invents a payroll
      // deduction against a named employee, which is a real financial claim
      // and not something a seed gets to assert.
      return shortage
        ? {
            eventType: 'outlet_stock_adjustment',
            debit: '6400',
            credit: '1110',
            memo: 'Selisih opname outlet (kurang, non-attributable)',
          }
        : {
            eventType: 'outlet_stock_adjustment',
            debit: '1110',
            credit: '4100',
            memo: 'Selisih opname outlet (lebih)',
          };
    },
  },
];

async function main(): Promise<void> {
  loadRepoEnv();
  const connectionString = migrationConnectionString('seed-journal');
  const client = new pg.Client({ connectionString });
  await client.connect();
  console.log(`Journal backfill — ${describeConnection(connectionString)}`);

  try {
    const accounts = new Map<string, string>();
    for (const r of (await client.query('SELECT code, id FROM chart_of_accounts')).rows as {
      code: string;
      id: string;
    }[]) {
      accounts.set(r.code, r.id);
    }

    let total = 0;
    for (const backfill of BACKFILLS) {
      const docs = (await client.query(backfill.sql)).rows as UnpostedDoc[];
      let written = 0;

      for (const doc of docs) {
        const { eventType, debit, credit, memo } = backfill.route(doc);
        const debitId = accounts.get(debit);
        const creditId = accounts.get(credit);
        if (!debitId || !creditId) {
          throw new Error(
            `Journal backfill: unknown account code ${!debitId ? debit : credit} for ${backfill.refType}`,
          );
        }

        // The fiscal period must already exist. A seeded document dated
        // outside every seeded period is a seed bug worth surfacing, not
        // something to paper over by inventing a period here.
        const period = (
          await client.query(
            `SELECT id FROM fiscal_periods WHERE $1::date BETWEEN start_date AND end_date`,
            [doc.entry_date],
          )
        ).rows[0] as { id: string } | undefined;
        if (!period) {
          console.warn(
            `  ! skipped ${backfill.refType} ${doc.id}: no fiscal period covers ${doc.entry_date}`,
          );
          continue;
        }

        const entryNumber = (
          await client.query('SELECT allocate_document_number($1, $2) AS num', [
            'JE',
            doc.entry_date.slice(0, 7).replace('-', ''),
          ])
        ).rows[0].num as string;

        const inserted = await client.query(
          `INSERT INTO journal_entries
             (entry_number, entry_date, fiscal_period_id, event_type, source, ref_type, ref_id,
              location_id, description, status, posted_by)
           VALUES ($1,$2,$3,$4,'system',$5,$6,$7,$8,'posted',NULL)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            entryNumber,
            doc.entry_date,
            period.id,
            eventType,
            backfill.refType,
            doc.id,
            doc.location_id,
            memo,
          ],
        );
        const entryId = inserted.rows[0]?.id as string | undefined;
        // `ON CONFLICT DO NOTHING` covers the system-event unique index, so a
        // concurrent or repeated run simply yields no row here.
        if (!entryId) continue;

        for (const [lineNo, accountId, dr, cr] of [
          [1, debitId, doc.amount, '0.00'],
          [2, creditId, '0.00', doc.amount],
        ] as [number, string, string, string][]) {
          await client.query(
            `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, location_id, memo)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [entryId, lineNo, accountId, dr, cr, doc.location_id, memo],
          );
        }
        written += 1;
      }

      total += written;
      console.log(`  - ${backfill.label}: ${written} posted (${docs.length} candidate(s))`);
    }

    console.log(
      total === 0
        ? '\n✓ Nothing to post — every terminal document already has its journal entry.'
        : `\n✓ Posted ${total} journal entr${total === 1 ? 'y' : 'ies'}.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
