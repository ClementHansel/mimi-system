import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  DocumentPrefix,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_PERIOD_CLOSED,
  ERR_VALIDATION,
  formatCloudDocNumber,
  validateJournalEntry,
  type JournalEntry,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import type { CreateJournalEntryDto, ListJournalQueryDto } from './dto/accounting.dto';
import type { DraftLine, JournalEntryRow, JournalLineRow } from './accounting.types';
import { withWrite } from './db-tx';

const ENTRY_SELECT = `
  SELECT je.id, je.entry_number, je.entry_date, je.fiscal_period_id, je.event_type, je.source, je.ref_type,
         je.ref_id, je.location_id, l.name AS location_name, je.description, je.status,
         je.reversed_by_entry_id, je.posted_by, je.posted_at
    FROM journal_entries je
    LEFT JOIN locations l ON l.id = je.location_id
`;

const LINE_SELECT = `
  SELECT jl.id, jl.entry_id, jl.line_no, jl.account_id, coa.code AS account_code, coa.name AS account_name,
         jl.debit, jl.credit, jl.location_id, jl.memo
    FROM journal_lines jl
    JOIN chart_of_accounts coa ON coa.id = jl.account_id
`;

export interface PostSystemEntryParams {
  entryDate: string;
  eventType: string;
  refType: string;
  refId: UUID | null;
  locationId: UUID | null;
  description: string;
  lines: DraftLine[];
}

/**
 * M17 double-entry GL core (CONTRACTS.md §4.17, §1.10 blocks 092/093). Every
 * write here goes through `@mimi/shared/gl/validator`'s `validateJournalEntry`
 * — an unbalanced entry is REJECTED (`ERR_UNBALANCED_ENTRY`), never silently
 * corrected with a plug line (D-04's one non-negotiable invariant). Manual
 * entries (`source='manual'`) and system entries from the posting engine
 * (`source='system'`) share this one insert path — the engine's idempotency
 * guarantee ("the engine can replay events safely") comes from the DB's own
 * `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` constraint
 * (migration 092), asserted here via `ON CONFLICT DO NOTHING` rather than a
 * SELECT-then-INSERT race.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly coa: ChartOfAccountsService,
    private readonly periods: FiscalPeriodsService,
  ) {}

  async list(client: PoolClient, query: ListJournalQueryDto): Promise<Paginated<JournalEntry>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.from) {
      conds.push(`je.entry_date >= $${i++}`);
      args.push(query.from);
    }
    if (query.to) {
      conds.push(`je.entry_date <= $${i++}`);
      args.push(query.to);
    }
    if (query.eventType) {
      conds.push(`je.event_type = $${i++}`);
      args.push(query.eventType);
    }
    if (query.locationId) {
      conds.push(`je.location_id = $${i++}`);
      args.push(query.locationId);
    }
    if (query.source) {
      conds.push(`je.source = $${i++}`);
      args.push(query.source);
    }
    if (query.accountCode) {
      conds.push(
        `EXISTS (SELECT 1 FROM journal_lines jl2 JOIN chart_of_accounts c2 ON c2.id = jl2.account_id WHERE jl2.entry_id = je.id AND c2.code = $${i++})`,
      );
      args.push(query.accountCode);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      client.query<JournalEntryRow>(
        `${ENTRY_SELECT} ${where} ORDER BY je.entry_date DESC, je.entry_number DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM journal_entries je ${where}`,
        args,
      ),
    ]);

    const result: JournalEntry[] = [];
    for (const row of rows.rows) {
      result.push(await this.toJournalEntry(client, row));
    }
    return { rows: result, total: Number(count.rows[0]?.count ?? '0'), page, pageSize };
  }

  async getDetail(client: PoolClient, id: UUID): Promise<JournalEntry> {
    const row = await this.requireEntry(client, id);
    return this.toJournalEntry(client, row);
  }

  /** `POST /api/accounting/journal` — a manual entry, `source='manual'`. Rejects unbalanced (`ERR_UNBALANCED_ENTRY`) and closed/locked periods (`ERR_PERIOD_CLOSED`). */
  async postManual(
    client: PoolClient,
    postedBy: UUID,
    dto: CreateJournalEntryDto,
  ): Promise<JournalEntry> {
    const draftLines: DraftLine[] = dto.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit ?? '0.00',
      credit: l.credit ?? '0.00',
      memo: l.memo ?? null,
    }));

    const validation = validateJournalEntry({
      lines: draftLines.map((l) => ({ ...l, memo: l.memo ?? undefined })),
    });
    if (!validation.ok) {
      throw new BadRequestException({ code: validation.code, message: validation.message });
    }

    return withWrite(client, async () => {
      // `findOrCreateForDate` itself may INSERT (auto-open the calendar period on first touch) — that
      // write, and the ERR_PERIOD_CLOSED check that depends on its result, both have to be inside the
      // same transaction as the entry insert below so a rejection here rolls back the harmless
      // period auto-create too, not leave it half-committed by RlsCleanupInterceptor's ROLLBACK.
      const period = await this.periods.findOrCreateForDate(client, dto.entryDate);
      if (period.status !== 'open') {
        throw new ConflictException({
          code: ERR_PERIOD_CLOSED,
          message: `Fiscal period ${period.period_code} is '${period.status}' — cannot post into it`,
        });
      }

      const entryId = await this.insertEntry(client, {
        entryDate: dto.entryDate,
        fiscalPeriodId: period.id,
        eventType: null,
        source: 'manual',
        refType: null,
        refId: null,
        locationId: dto.locationId ?? null,
        description: dto.description,
        postedBy,
        lines: draftLines,
      });

      return this.getDetail(client, entryId);
    });
  }

  /**
   * The posting engine's one write path (`PostingEngineService`, `X`-prefixed
   * system rules, and `PaymentVerificationsService`'s pay-time postings all
   * call this — never `journal_entries`/`journal_lines` directly). Idempotent
   * per `(event_type, ref_type, ref_id)`: a replayed domain event (the
   * `EventBus` re-delivering, or a sync-replay upstream) silently no-ops
   * instead of double-posting. Returns `null` on that no-op path so callers
   * can distinguish "posted" from "already posted" without a second query.
   */
  async postSystemEntry(
    client: PoolClient,
    params: PostSystemEntryParams,
  ): Promise<JournalEntry | null> {
    const validation = validateJournalEntry({
      lines: params.lines.map((l) => ({ ...l, memo: l.memo ?? undefined })),
    });
    if (!validation.ok) {
      throw new BadRequestException({
        code: validation.code,
        message: `Posting rule for '${params.eventType}' (ref ${params.refType}/${params.refId}) produced an unbalanced entry: ${validation.message}`,
      });
    }

    // System (event-driven) postings never hard-fail on a closed/locked period — the domain action
    // already happened; the GL must still reflect it. `findOrCreateForDate` auto-opens the calendar
    // period on first touch, so this only matters for a period some human already explicitly closed —
    // that case still posts (Finance can see it landed in a closed period via the entry's own
    // `entry_date` vs. the period's `status`), rather than silently dropping a real domain event.
    const period = await this.periods.findOrCreateForDate(client, params.entryDate);
    const targetPeriodId = period.id;

    const entryNumber = await this.nextEntryNumber(client);
    const insertRes = await client.query<{ id: UUID }>(
      `INSERT INTO journal_entries (entry_number, entry_date, fiscal_period_id, event_type, source, ref_type, ref_id, location_id, description, status, posted_by)
       VALUES ($1,$2,$3,$4,'system',$5,$6,$7,$8,'posted', NULL)
       ON CONFLICT (event_type, ref_type, ref_id) WHERE source = 'system' DO NOTHING
       RETURNING id`,
      [
        entryNumber,
        params.entryDate,
        targetPeriodId,
        params.eventType,
        params.refType,
        params.refId,
        params.locationId,
        params.description,
      ],
    );
    const entryId = insertRes.rows[0]?.id;
    if (!entryId) return null; // idempotent replay — a system entry for this (eventType, refType, refId) already exists

    await this.insertLines(client, entryId, params.lines);
    return this.getDetail(client, entryId);
  }

  /** `POST /api/accounting/journal/:id/reverse` — a NEW entry with every debit/credit swapped, linked via `reversed_by_entry_id`. Never mutates/deletes the original (D-04 append-only). */
  async reverse(
    client: PoolClient,
    actorId: UUID,
    id: UUID,
    reason: string,
  ): Promise<JournalEntry> {
    const original = await this.requireEntry(client, id);
    if (original.status === 'reversed') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Journal entry ${original.entry_number} is already reversed`,
      });
    }
    const period = await this.periods.get(client, original.fiscal_period_id);
    if (period.status === 'locked') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Fiscal period ${period.period_code} is 'locked' — reversal entries are forbidden`,
      });
    }
    if (period.status === 'closed') {
      throw new ConflictException({
        code: ERR_PERIOD_CLOSED,
        message: `Fiscal period ${period.period_code} is 'closed'`,
      });
    }

    const originalLines = await this.lines(client, id);
    const swapped: DraftLine[] = originalLines.map((l) => ({
      accountCode: l.account_code,
      debit: l.credit,
      credit: l.debit,
      memo: l.memo,
    }));
    const entryDate = new Date().toISOString().slice(0, 10);

    return withWrite(client, async () => {
      // First actual write is `findOrCreateForDate` below (may auto-open the reversal's calendar
      // period) — everything from here to the final status flip on the original entry must commit
      // atomically, same reasoning as `postManual` above.
      const reversalPeriod = await this.periods.findOrCreateForDate(client, entryDate);
      const entryNumber = await this.nextEntryNumber(client);
      const reversalId = await this.insertEntry(client, {
        entryDate,
        fiscalPeriodId: reversalPeriod.id,
        eventType: original.event_type,
        source: 'manual',
        refType: original.ref_type,
        refId: original.ref_id,
        locationId: original.location_id,
        description: `Reversal of ${original.entry_number}: ${reason}`,
        postedBy: actorId,
        lines: swapped,
        entryNumberOverride: entryNumber,
      });

      await client.query(
        `UPDATE journal_entries SET status = 'reversed', reversed_by_entry_id = $2 WHERE id = $1`,
        [id, reversalId],
      );
      return this.getDetail(client, reversalId);
    });
  }

  async postingRules(
    client: PoolClient,
    eventType?: string,
  ): Promise<
    {
      eventType: string;
      ruleSeq: number;
      condition: object | null;
      debitAccountCode: string;
      creditAccountCode: string;
      amountSource: string;
      isActive: boolean;
    }[]
  > {
    const where = eventType ? `WHERE event_type = $1` : '';
    const res = await client.query<{
      event_type: string;
      rule_seq: number;
      condition: object | null;
      debit_account_code: string;
      credit_account_code: string;
      amount_source: string;
      is_active: boolean;
    }>(
      `SELECT event_type, rule_seq, condition, debit_account_code, credit_account_code, amount_source, is_active
         FROM posting_rules ${where} ORDER BY event_type, rule_seq`,
      eventType ? [eventType] : [],
    );
    return res.rows.map((r) => ({
      eventType: r.event_type,
      ruleSeq: r.rule_seq,
      condition: r.condition,
      debitAccountCode: r.debit_account_code,
      creditAccountCode: r.credit_account_code,
      amountSource: r.amount_source,
      isActive: r.is_active,
    }));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async requireEntry(client: PoolClient, id: UUID): Promise<JournalEntryRow> {
    const res = await client.query<JournalEntryRow>(`${ENTRY_SELECT} WHERE je.id = $1`, [id]);
    const row = res.rows[0];
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Journal entry ${id} not found`,
      });
    return row;
  }

  private async lines(client: PoolClient, entryId: UUID): Promise<JournalLineRow[]> {
    const res = await client.query<JournalLineRow>(
      `${LINE_SELECT} WHERE jl.entry_id = $1 ORDER BY jl.line_no`,
      [entryId],
    );
    return res.rows;
  }

  private async toJournalEntry(client: PoolClient, row: JournalEntryRow): Promise<JournalEntry> {
    const lineRows = await this.lines(client, row.id);
    return {
      id: row.id,
      entryNumber: row.entry_number,
      // See `accounting.types.ts`'s `formatDateOnly` doc comment — a raw `row.entry_date` (a `pg`-
      // parsed `Date`, despite `JournalEntryRow`'s `string` type) would serialize one day off under
      // Asia/Makassar (UTC+8), same bug class as the periods camelCase leak the coordinator flagged.
      entryDate: formatDateOnly(row.entry_date),
      eventType: row.event_type,
      source: row.source,
      refType: row.ref_type,
      refId: row.ref_id,
      locationName: row.location_name,
      description: row.description,
      status: row.status,
      lines: lineRows.map((l) => ({
        lineNo: l.line_no,
        accountCode: l.account_code,
        accountName: l.account_name,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
    };
  }

  private async nextEntryNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.JOURNAL_ENTRY, period],
    );
    return formatCloudDocNumber(DocumentPrefix.JOURNAL_ENTRY, period, res.rows[0]!.last_number, 5);
  }

  private async insertEntry(
    client: PoolClient,
    params: {
      entryDate: string;
      fiscalPeriodId: UUID;
      eventType: string | null;
      source: 'system' | 'manual';
      refType: string | null;
      refId: UUID | null;
      locationId: UUID | null;
      description: string;
      postedBy: UUID | null;
      lines: DraftLine[];
      entryNumberOverride?: string;
    },
  ): Promise<UUID> {
    const entryNumber = params.entryNumberOverride ?? (await this.nextEntryNumber(client));
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO journal_entries (entry_number, entry_date, fiscal_period_id, event_type, source, ref_type, ref_id, location_id, description, status, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10)
       RETURNING id`,
      [
        entryNumber,
        params.entryDate,
        params.fiscalPeriodId,
        params.eventType,
        params.source,
        params.refType,
        params.refId,
        params.locationId,
        params.description,
        params.postedBy,
      ],
    );
    const entryId = res.rows[0]!.id;
    await this.insertLines(client, entryId, params.lines);
    return entryId;
  }

  private async insertLines(client: PoolClient, entryId: UUID, lines: DraftLine[]): Promise<void> {
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      const account = await this.coa.requireByCode(client, line.accountCode);
      if (!account.is_postable) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Account ${account.code} (${account.name}) is a header account (is_postable=false) and cannot receive postings`,
        });
      }
      await client.query(
        `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
        [entryId, lineNo, account.id, line.debit, line.credit, line.memo ?? null],
      );
    }
  }
}

// re-exported for the posting engine / payments service, which build `DraftLine[]` themselves
export type { DraftLine } from './accounting.types';
export type { Money as JournalMoney } from '@mimi/shared';
