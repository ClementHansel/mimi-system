import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/**
 * A-7 / B-16 aftermath — how much history is missing from the general ledger.
 *
 * ## Why this exists before any backfill does
 *
 * B-16 found that 13 of 25 posting rules were defined, unit-tested and never
 * actually triggered by production code. Twelve are wired now — but wiring only
 * covers documents approved AFTER the wiring landed. Everything approved before
 * it has no journal entry and never will, unless something goes back for it.
 *
 * PROGRESS records the sales side as backfillable per-day via
 * `POST /api/accounting/daily-posting`, and the DOCUMENT side as having no
 * backfill at all. Before writing one, somebody has to be able to answer "how
 * much, and of what?" — and right now nobody can. Backfilling production is
 * explicitly the owner's decision, and this is the report that decision needs.
 *
 * **This service only ever READS.** It posts nothing, changes nothing, and is
 * safe to call on production at any time.
 *
 * ## How a gap is identified
 *
 * `journal_entries` carries `(event_type, ref_type, ref_id)` with a UNIQUE
 * index over them for `source='system'` — that triple IS the engine's
 * idempotency key, and `ref_type` is exactly the `documentType` the publishing
 * module passes on `journal.action`. So a document in a terminal state with no
 * matching `journal_entries` row is, precisely, an unposted document.
 *
 * The `ref_type` values below were read off the actual `journal.action` publish
 * sites rather than from the migration's column comment, which lists a slightly
 * different set (`sale_day`, `po_receipt` and `sj_drops` differ). Where those
 * two disagree, the publishing code is what the data will actually contain.
 *
 * Every status and timestamp below was likewise read from the LIVE schema
 * (`pg_get_constraintdef` + `information_schema.columns`), not from memory. Two
 * of them were wrong on the first pass — `returns` has no 'shipped' status (it
 * is 'in_transit') and `sj_drops` never reaches 'received' (it 'completed's).
 * Either would have reported zero gaps forever while looking correct.
 */

export interface GlCoverageGap {
  /** `journal_entries.ref_type`, i.e. the publishing module's `documentType`. */
  refType: string;
  /** Plain-language description of which documents are counted. */
  scope: string;
  /** Terminal documents of this type. */
  total: number;
  /** Of those, how many have NO `journal_entries` row. */
  unposted: number;
  /** Oldest and newest unposted document, so the owner can see the window. */
  oldestUnpostedAt: string | null;
  newestUnpostedAt: string | null;
}

export interface GlCoverageReport {
  generatedAt: string;
  gaps: GlCoverageGap[];
  totalUnposted: number;
}

/**
 * One probe per document type: the table, the terminal-state filter, and the
 * timestamp that dates the document.
 *
 * Kept as data rather than as one hand-written UNION so that adding a document
 * type is one row, and so each entry can carry the note explaining what its
 * terminal state actually means. `ref_type` must match the publishing site
 * exactly — a typo here silently reports zero gaps, which is the most
 * dangerous possible failure for a report whose whole job is to find gaps.
 */
interface Probe {
  refType: string;
  scope: string;
  table: string;
  /**
   * SQL predicate selecting documents that SHOULD have posted by now.
   *
   * MUST qualify its columns with the `d.` alias: the query joins
   * `journal_entries`, which has its OWN `status` column, so a bare `status`
   * is ambiguous and Postgres rejects the whole query at runtime. It compiles
   * fine and fails in production, which is exactly what it did.
   */
  terminal: string;
  /** Column that dates the document, for the window in the report. */
  dateColumn: string;
}

const PROBES: readonly Probe[] = [
  {
    refType: 'waste_record',
    scope: 'approved waste records (JOUT-04 / JGUD-05)',
    table: 'waste_records',
    terminal: `d.status = 'approved'`,
    dateColumn: 'approved_at',
  },
  {
    refType: 'return',
    scope: 'returns that have shipped or later (JOUT-06 / JGUD-04 / JGUD-02)',
    table: 'returns',
    // Verified against the live CHECK constraint: there is no 'shipped'
    // status — the shipped leg is 'in_transit'. Guessing here would have
    // reported zero gaps forever, which is the worst possible failure for a
    // report whose entire job is to find them.
    terminal: `d.status IN ('in_transit', 'received', 'completed')`,
    dateColumn: 'shipped_at',
  },
  {
    refType: 'stock_adjustment',
    scope: 'approved stock opnames (JOUT-05 / JGUD-06)',
    table: 'stock_opname',
    terminal: `d.status = 'adjusted'`,
    dateColumn: 'approved_at',
  },
  {
    refType: 'petty_cash',
    scope: 'verified petty-cash claims (JOUT-07 / JOUT-08)',
    table: 'petty_cash',
    terminal: `d.status = 'verified'`,
    dateColumn: 'verified_at',
  },
  {
    refType: 'surat_jalan',
    scope: 'dispatched Surat Jalan (JGUD-03)',
    table: 'surat_jalan',
    terminal: `d.status IN ('in_transit', 'completed')`,
    dateColumn: 'dispatched_at',
  },
  {
    refType: 'sj_drops',
    scope: 'received drops (JOUT-01)',
    table: 'sj_drops',
    // Also from the CHECK constraint: a drop never reaches 'received'. It
    // completes, with or without a discrepancy, and both post.
    terminal: `d.status IN ('completed', 'completed_discrepancy')`,
    dateColumn: 'received_at',
  },
];

@Injectable()
export class GlCoverageService {
  /**
   * Counts unposted documents per type.
   *
   * A LEFT JOIN anti-match rather than `NOT EXISTS (SELECT …)` per row: these
   * tables carry tens of thousands of rows on a real deployment and this is a
   * report someone will run on production while people are using it.
   *
   * `source = 'system'` is part of the match because a MANUAL journal entry
   * against the same document is a bookkeeper's own correction — it does not
   * mean the engine posted, and counting it as coverage would hide exactly the
   * gap this looks for.
   */
  async report(client: PoolClient): Promise<GlCoverageReport> {
    const gaps: GlCoverageGap[] = [];

    for (const probe of PROBES) {
      const res = await client.query<{
        total: string;
        unposted: string;
        oldest: Date | null;
        newest: Date | null;
      }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE je.id IS NULL)::text AS unposted,
           MIN(d.${probe.dateColumn}) FILTER (WHERE je.id IS NULL) AS oldest,
           MAX(d.${probe.dateColumn}) FILTER (WHERE je.id IS NULL) AS newest
         FROM ${probe.table} d
         LEFT JOIN journal_entries je
           ON je.ref_type = $1 AND je.ref_id = d.id AND je.source = 'system'
         WHERE ${probe.terminal}`,
        [probe.refType],
      );

      const row = res.rows[0]!;
      gaps.push({
        refType: probe.refType,
        scope: probe.scope,
        total: Number(row.total),
        unposted: Number(row.unposted),
        oldestUnpostedAt: row.oldest ? row.oldest.toISOString() : null,
        newestUnpostedAt: row.newest ? row.newest.toISOString() : null,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      gaps,
      totalUnposted: gaps.reduce((sum, g) => sum + g.unposted, 0),
    };
  }
}

/** Exported for tests: the document types this report knows how to check. */
export const GL_COVERAGE_REF_TYPES: readonly string[] = PROBES.map((p) => p.refType);
