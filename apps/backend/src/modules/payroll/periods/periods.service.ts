import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  payrollPeriodBoundaries,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { pgDateToIso } from '../pg-date.util';
import { withWrite } from '../db-tx';

export interface PeriodRow {
  id: UUID;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'processing' | 'closed';
  runs: { id: UUID; runNumber: string; status: string }[];
}

/**
 * M15 `payroll` — periods (FR-HR-04, CONTRACTS.md §4.15). A period is just
 * the calendar window (`'YYYY-MM'` -> start/end date, `../pg-date.util`'s
 * sibling `payrollPeriodBoundaries` from `@mimi/shared`); the actual
 * calculation is `RunsService.calculateForPeriod` (a period's `/calculate`
 * route lives on `PeriodsController` per CONTRACTS' path, but the heavy
 * lifting is a RUN concern — kept in `RunsService` so `PeriodsService` stays
 * a thin CRUD layer).
 */
@Injectable()
export class PeriodsService {
  async list(client: PoolClient, page = 1, pageSize = 50): Promise<Paginated<PeriodRow>> {
    const countRes = await client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM payroll_periods',
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const res = await client.query<Record<string, any>>(
      `SELECT * FROM payroll_periods ORDER BY period_code DESC LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );
    const rows: PeriodRow[] = [];
    for (const r of res.rows) {
      const runsRes = await client.query<{ id: UUID; run_number: string; status: string }>(
        'SELECT id, run_number, status FROM payroll_runs WHERE period_id = $1 ORDER BY run_seq ASC',
        [r.id],
      );
      rows.push(this.mapPeriod(r, runsRes.rows));
    }
    return { rows, total, page, pageSize };
  }

  async create(client: PoolClient, periodCode: string): Promise<PeriodRow> {
    const { startDate, endDate } = payrollPeriodBoundaries(periodCode);

    const existing = await client.query<{ id: UUID }>(
      'SELECT id FROM payroll_periods WHERE period_code = $1',
      [periodCode],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Period ${periodCode} already exists`,
      });
    }

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `INSERT INTO payroll_periods (period_code, start_date, end_date) VALUES ($1,$2,$3) RETURNING *`,
        [periodCode, startDate, endDate],
      );
      return this.mapPeriod(res.rows[0]!, []);
    });
  }

  async requirePeriod(
    client: PoolClient,
    id: UUID,
  ): Promise<{ id: UUID; periodCode: string; startDate: string; endDate: string; status: string }> {
    const res = await client.query<Record<string, any>>(
      'SELECT * FROM payroll_periods WHERE id = $1',
      [id],
    );
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Payroll period not found' });
    const r = res.rows[0]!;
    return {
      id: r.id,
      periodCode: r.period_code,
      startDate: pgDateToIso(r.start_date),
      endDate: pgDateToIso(r.end_date),
      status: r.status,
    };
  }

  async markStatus(
    client: PoolClient,
    id: UUID,
    status: 'open' | 'processing' | 'closed',
  ): Promise<void> {
    await client.query('UPDATE payroll_periods SET status = $2 WHERE id = $1', [id, status]);
  }

  private mapPeriod(
    r: Record<string, any>,
    runs: { id: UUID; run_number: string; status: string }[],
  ): PeriodRow {
    return {
      id: r.id,
      periodCode: r.period_code,
      startDate: pgDateToIso(r.start_date),
      endDate: pgDateToIso(r.end_date),
      status: r.status,
      runs: runs.map((run) => ({ id: run.id, runNumber: run.run_number, status: run.status })),
    };
  }
}
