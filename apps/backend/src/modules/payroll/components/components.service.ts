import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_CONFLICT, ERR_NOT_FOUND, ERR_VALIDATION, type Money, type UUID } from '@mimi/shared';
import type {
  CreateComponentDto,
  PutEmployeeComponentsDto,
  UpdateComponentDto,
} from '../dto/payroll.dto';
import { withWrite } from '../db-tx';

export interface ComponentApi {
  id: UUID;
  code: string;
  name: string;
  type: 'earning' | 'deduction' | 'employer_cost';
  calcMethod: string;
  formulaKey: string | null;
  defaultAmount: Money | null;
  isSystem: boolean;
  /**
   * `salary_components.is_active` (migration 064) — `UpdateComponentDto`
   * has always accepted `isActive` (the sanctioned way to retire a component
   * created by mistake, since the table has no delete and a component
   * referenced by a past payroll run must never be hard-deletable), but this
   * mapper never read the column back, so no GET could show current status
   * and no UI could tell an active row from a retired one. Added rather than
   * left for the frontend to infer.
   */
  isActive: boolean;
}

export interface EmployeeComponentApi {
  componentId: UUID;
  code: string;
  amount: Money | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * M15 `payroll` — salary component master (PIN-07/POUT-09 custom lines) and
 * per-employee assignment (PIN-03..06). The 16 seeded system components
 * (`is_system=true`) are non-deletable and, per CONTRACTS §4.15, only their
 * `defaultAmount`/`isActive` may be edited via `PATCH`.
 */
@Injectable()
export class ComponentsService {
  async list(client: PoolClient): Promise<ComponentApi[]> {
    const res = await client.query<Record<string, any>>(
      'SELECT * FROM salary_components ORDER BY sort_order ASC, name ASC',
    );
    return res.rows.map(this.mapComponent);
  }

  async create(client: PoolClient, dto: CreateComponentDto): Promise<ComponentApi> {
    if (!dto.code?.trim() || !dto.name?.trim())
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'code and name are required',
      });
    const existing = await client.query('SELECT id FROM salary_components WHERE code = $1', [
      dto.code,
    ]);
    if (existing.rows.length > 0)
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Component code '${dto.code}' already exists`,
      });

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `INSERT INTO salary_components (code, name, type, calc_method, default_amount, is_system)
         VALUES ($1,$2,$3,$4,$5,false) RETURNING *`,
        [dto.code, dto.name, dto.type, dto.calcMethod, dto.defaultAmount ?? null],
      );
      return this.mapComponent(res.rows[0]!);
    });
  }

  async update(client: PoolClient, id: UUID, dto: UpdateComponentDto): Promise<ComponentApi> {
    const existing = await client.query<{ is_system: boolean }>(
      'SELECT is_system FROM salary_components WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Component not found' });

    if (existing.rows[0]!.is_system && dto.name !== undefined) {
      throw new ForbiddenException({
        code: ERR_VALIDATION,
        message: "System components may only have 'defaultAmount'/'isActive' edited",
      });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.defaultAmount !== undefined) set('default_amount', dto.defaultAmount);
    if (dto.isActive !== undefined) set('is_active', dto.isActive);
    if (dto.name !== undefined) set('name', dto.name);

    if (sets.length === 0) {
      const res = await client.query<Record<string, any>>(
        'SELECT * FROM salary_components WHERE id = $1',
        [id],
      );
      return this.mapComponent(res.rows[0]!);
    }

    return withWrite(client, async () => {
      params.push(id);
      const res = await client.query<Record<string, any>>(
        `UPDATE salary_components SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return this.mapComponent(res.rows[0]!);
    });
  }

  async listForEmployee(client: PoolClient, employeeId: UUID): Promise<EmployeeComponentApi[]> {
    const res = await client.query<Record<string, any>>(
      `SELECT esc.*, sc.code FROM employee_salary_components esc JOIN salary_components sc ON sc.id = esc.component_id
        WHERE esc.employee_id = $1 ORDER BY esc.effective_from DESC`,
      [employeeId],
    );
    return res.rows.map((r) => ({
      componentId: r.component_id,
      code: r.code,
      amount: r.amount ?? null,
      effectiveFrom: this.dateStr(r.effective_from),
      effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null,
    }));
  }

  async putForEmployee(
    client: PoolClient,
    employeeId: UUID,
    dto: PutEmployeeComponentsDto,
  ): Promise<EmployeeComponentApi[]> {
    return withWrite(client, async () => {
      for (const a of dto.assignments) {
        // Close any currently-open window for this component, then insert the new one — same
        // "current row has end_date NULL" convention `employments` uses (CONTRACTS §1.7).
        await client.query(
          `UPDATE employee_salary_components SET effective_to = $3
            WHERE employee_id = $1 AND component_id = $2 AND effective_to IS NULL AND effective_from < $4`,
          [employeeId, a.componentId, a.effectiveFrom, a.effectiveFrom],
        );
        await client.query(
          `INSERT INTO employee_salary_components (employee_id, component_id, amount, effective_from)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, component_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
          [employeeId, a.componentId, a.amount ?? null, a.effectiveFrom],
        );
      }
      return this.listForEmployee(client, employeeId);
    });
  }

  private dateStr(value: unknown): string {
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return value as string;
  }

  private mapComponent = (r: Record<string, any>): ComponentApi => ({
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    calcMethod: r.calc_method,
    formulaKey: r.formula_key ?? null,
    defaultAmount: r.default_amount ?? null,
    isSystem: r.is_system,
    isActive: r.is_active,
  });
}
