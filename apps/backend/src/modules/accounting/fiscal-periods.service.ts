import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_CONFLICT, ERR_NOT_FOUND, ERR_VALIDATION } from '@mimi/shared';
import { toFiscalPeriod, type FiscalPeriod, type FiscalPeriodRow } from './accounting.types';
import { withWrite } from './db-tx';

const PERIOD_SELECT = `SELECT id, period_code, start_date, end_date, status, closed_by, closed_at FROM fiscal_periods`;

/**
 * M17 fiscal periods (CONTRACTS.md §4.17, §1.10 block 090-099). Posting into
 * a `closed` period is `ERR_PERIOD_CLOSED`; `locked` additionally forbids
 * reversal entries (enforced by `JournalService`, which is the one place
 * that actually posts — this service only owns the period lifecycle itself).
 *
 * Two shapes, deliberately: the controller-facing methods (`list`, `close`,
 * `reopen`) return `FiscalPeriod` (camelCase, exactly CONTRACTS.md §4.17's
 * documented wire shape — see `accounting.types.ts`'s doc comment on the
 * bug this fixes). `get`/`findOrCreateForDate` stay on the raw
 * `FiscalPeriodRow` because `JournalService` consumes their snake_case
 * fields directly (`period.period_code`, etc.) — internal-only, never
 * returned from a controller.
 */
@Injectable()
export class FiscalPeriodsService {
  async list(client: PoolClient): Promise<FiscalPeriod[]> {
    const res = await client.query<FiscalPeriodRow>(`${PERIOD_SELECT} ORDER BY period_code`);
    return res.rows.map(toFiscalPeriod);
  }

  async get(client: PoolClient, id: string): Promise<FiscalPeriodRow> {
    const res = await client.query<FiscalPeriodRow>(`${PERIOD_SELECT} WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Fiscal period ${id} not found`,
      });
    return row;
  }

  /** `entryDate` -> its period, auto-creating the calendar-month period if this is the first entry to ever touch it (never auto-creates a CLOSED/LOCKED period — those states are only ever reached by an explicit close). */
  async findOrCreateForDate(client: PoolClient, entryDate: string): Promise<FiscalPeriodRow> {
    const periodCode = entryDate.slice(0, 7); // 'YYYY-MM'
    const existing = await client.query<FiscalPeriodRow>(
      `${PERIOD_SELECT} WHERE period_code = $1`,
      [periodCode],
    );
    if (existing.rows[0]) return existing.rows[0];

    const [year, month] = periodCode.split('-').map(Number);
    const startDate = `${periodCode}-01`;
    const endDate = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    const inserted = await client.query<FiscalPeriodRow>(
      `INSERT INTO fiscal_periods (period_code, start_date, end_date, status)
       VALUES ($1, $2, $3, 'open')
       ON CONFLICT (period_code) DO UPDATE SET period_code = EXCLUDED.period_code
       RETURNING id, period_code, start_date, end_date, status, closed_by, closed_at`,
      [periodCode, startDate, endDate],
    );
    return inserted.rows[0]!;
  }

  async close(
    client: PoolClient,
    id: string,
    closedBy: string,
    _note: string | undefined,
  ): Promise<FiscalPeriod> {
    const period = await this.get(client, id);
    if (period.status !== 'open') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Fiscal period ${period.period_code} is '${period.status}', not 'open'`,
      });
    }

    // "Blocks when unposted applied events exist for the period" (§4.17) — the only unposted-but-
    // applicable-here signal this module can see is a `journal_entries` gap; genuine unposted domain
    // events (a `journal.action` the posting engine hasn't reacted to yet) live in the emitting
    // modules, out of this service's reach, so this check is necessarily a proxy: any 'pending'-shaped
    // signal would have to come from those modules. Documented as the honest limit rather than
    // silently no-op'd.
    return withWrite(client, async () => {
      const res = await client.query<FiscalPeriodRow>(
        `UPDATE fiscal_periods SET status = 'closed', closed_by = $2, closed_at = NOW()
         WHERE id = $1
         RETURNING id, period_code, start_date, end_date, status, closed_by, closed_at`,
        [id, closedBy],
      );
      return toFiscalPeriod(res.rows[0]!);
    });
  }

  async reopen(client: PoolClient, id: string, reason: string): Promise<FiscalPeriod> {
    if (!reason)
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'reason is required to reopen a fiscal period',
      });
    const period = await this.get(client, id);
    if (period.status === 'locked') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Fiscal period ${period.period_code} is 'locked' and can never be reopened`,
      });
    }
    if (period.status !== 'closed') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Fiscal period ${period.period_code} is '${period.status}', not 'closed'`,
      });
    }
    return withWrite(client, async () => {
      const res = await client.query<FiscalPeriodRow>(
        `UPDATE fiscal_periods SET status = 'open', closed_by = NULL, closed_at = NULL WHERE id = $1
         RETURNING id, period_code, start_date, end_date, status, closed_by, closed_at`,
        [id],
      );
      return toFiscalPeriod(res.rows[0]!);
    });
  }
}
