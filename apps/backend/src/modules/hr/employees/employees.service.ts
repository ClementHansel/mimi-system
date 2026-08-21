import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  EmploymentStatus,
  type Employee,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import type { CreateEmployeeDto, UpdateEmployeeDto } from '../dto/employee.dto';
import { pgDateToIso } from '../pg-date.util';
import { withWrite } from '../db-tx';

export interface EmploymentHistoryEntry {
  position: string;
  locationName: string;
  baseSalary?: Money;
  startDate: string;
  endDate: string | null;
}

export type EmployeeDetail = Employee & { employments: EmploymentHistoryEntry[] };

/**
 * M14 `hr` — Employee & employment records (CONTRACTS.md §4.14, §1.7 block
 * 060). `employees` is the roster (identity, position, home location);
 * `employments` is the position/salary HISTORY the ticket calls out as a
 * payroll (M15) input — every `employmentChange` on `PATCH .../:id` appends
 * a new row rather than overwriting the current one, so tenure and past
 * base-salary stay reconstructable.
 *
 * `employees` is class M (CONTRACTS §3.2 field-projected on the wire —
 * salary/bank/KTP never leave the cloud); `employments` is class X (never
 * synced at all — salary-bearing). Only `employees.*` mutations call
 * `SyncEmitService`.
 */
@Injectable()
export class EmployeesService {
  constructor(private readonly syncEmit: SyncEmitService) {}

  async list(
    client: PoolClient,
    locationId: string | undefined,
    status: EmploymentStatus | undefined,
    q: string | undefined,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<Employee>> {
    const params: unknown[] = [];
    let where = '1=1';

    if (locationId) {
      params.push(locationId);
      where += ` AND e.location_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND e.employment_status = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (e.name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM employees e WHERE ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<Record<string, any>>(
      `SELECT e.*, l.name AS location_name
         FROM employees e
         JOIN locations l ON l.id = e.location_id
        WHERE ${where}
        ORDER BY e.name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: res.rows.map(this.mapEmployee), total, page, pageSize };
  }

  async getById(client: PoolClient, id: UUID, includeSalary: boolean): Promise<EmployeeDetail> {
    const res = await client.query<Record<string, any>>(
      `SELECT e.*, l.name AS location_name FROM employees e JOIN locations l ON l.id = e.location_id WHERE e.id = $1`,
      [id],
    );
    if (res.rows.length === 0)
      throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Employee not found' });

    const employmentsRes = await client.query<Record<string, any>>(
      `SELECT em.*, l.name AS location_name
         FROM employments em
         JOIN locations l ON l.id = em.location_id
        WHERE em.employee_id = $1
        ORDER BY em.start_date DESC`,
      [id],
    );

    return {
      ...this.mapEmployee(res.rows[0]!),
      employments: employmentsRes.rows.map((r) => ({
        position: r.position,
        locationName: r.location_name,
        ...(includeSalary ? { baseSalary: r.base_salary as Money } : {}),
        startDate: pgDateToIso(r.start_date),
        endDate: r.end_date ? pgDateToIso(r.end_date) : null,
      })),
    };
  }

  /**
   * The caller's own record, resolved from their user id — the `employee`
   * interface's Data Pribadi.
   *
   * `includeSalary: true` on purpose: this is YOUR employment history, and your
   * own base salary is not a secret from you (it is on the payslip you can
   * already open). The office's field projection exists to keep salaries away
   * from OTHER people's records, which this route cannot reach — RLS
   * (`employees_scope`, `app_is_self`) allows exactly one row here.
   *
   * A user with no `employees` row is not an error worth 500-ing over: not
   * every login is an employee (a shared POS account, a service user), so this
   * answers 404 with a message that says which case it is.
   */
  async findByUserId(client: PoolClient, userId: UUID): Promise<EmployeeDetail> {
    const res = await client.query<{ id: string }>(`SELECT id FROM employees WHERE user_id = $1`, [
      userId,
    ]);
    const row = res.rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'ERR_NOT_FOUND',
        message: 'This account is not linked to an employee record',
      });
    return this.getById(client, row.id, true);
  }

  async create(client: PoolClient, actorUserId: UUID, dto: CreateEmployeeDto): Promise<Employee> {
    if (!dto.employeeNumber?.trim())
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'employeeNumber is required',
      });
    if (!dto.name?.trim())
      throw new BadRequestException({ code: 'ERR_VALIDATION', message: 'name is required' });

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `INSERT INTO employees
           (employee_number, user_id, name, nik, phone, email, join_date, position, location_id, bank_name, bank_account_number, bank_account_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          dto.employeeNumber.trim(),
          dto.userId ?? null,
          dto.name.trim(),
          dto.nik ?? null,
          dto.phone ?? null,
          dto.email ?? null,
          dto.joinDate,
          dto.position,
          dto.locationId,
          dto.bankName ?? null,
          dto.bankAccountNumber ?? null,
          dto.bankAccountName ?? null,
        ],
      );
      const employeeId = res.rows[0]!.id as UUID;

      // The employee's founding employment record (position/salary/tenure start — M15's PIN-01/05/06 input).
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1,$2,$3,$4,$5)`,
        [employeeId, dto.position, dto.locationId, dto.baseSalary, dto.joinDate],
      );

      const locRes = await client.query<{ name: string }>(
        'SELECT name FROM locations WHERE id = $1',
        [dto.locationId],
      );
      const employee = this.mapEmployee({
        ...res.rows[0],
        location_name: locRes.rows[0]?.name ?? '',
      });

      await this.syncEmit.emit(client, {
        entity: 'employees',
        op: 'created',
        entityId: employee.id,
        locationId: dto.locationId,
        actorUserId,
        data: {
          id: employee.id,
          name: employee.name,
          position: employee.position,
          locationId: dto.locationId,
          isActive: true,
        },
      });

      return employee;
    });
  }

  async update(
    client: PoolClient,
    actorUserId: UUID,
    id: UUID,
    dto: UpdateEmployeeDto,
  ): Promise<Employee> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (dto.name !== undefined) set('name', dto.name);
    if (dto.nik !== undefined) set('nik', dto.nik);
    if (dto.phone !== undefined) set('phone', dto.phone);
    if (dto.email !== undefined) set('email', dto.email);
    if (dto.address !== undefined) set('address', dto.address);
    if (dto.birthDate !== undefined) set('birth_date', dto.birthDate);
    if (dto.employmentStatus !== undefined) set('employment_status', dto.employmentStatus);
    if (dto.bankName !== undefined) set('bank_name', dto.bankName);
    if (dto.bankAccountNumber !== undefined) set('bank_account_number', dto.bankAccountNumber);
    if (dto.bankAccountName !== undefined) set('bank_account_name', dto.bankAccountName);

    if (dto.employmentChange) {
      set('position', dto.employmentChange.position);
      set('location_id', dto.employmentChange.locationId);
    }

    return withWrite(client, async () => {
      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(
          `UPDATE employees SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
          params,
        );
        if (res.rows.length === 0)
          throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Employee not found' });
      }

      if (dto.employmentChange) {
        // Close the current open-ended employment row and append the new one — CONTRACTS.md §1.7:
        // "position/salary history; current row has end_date NULL".
        await client.query(
          `UPDATE employments SET end_date = $2 WHERE employee_id = $1 AND end_date IS NULL`,
          [id, dto.employmentChange.startDate],
        );
        await client.query(
          `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            id,
            dto.employmentChange.position,
            dto.employmentChange.locationId,
            dto.employmentChange.baseSalary,
            dto.employmentChange.startDate,
          ],
        );
      }

      const updated = await this.getById(client, id, false);

      await this.syncEmit.emit(client, {
        entity: 'employees',
        op: 'updated',
        entityId: id,
        locationId: updated.locationId,
        actorUserId,
        data: {
          id,
          name: updated.name,
          position: updated.position,
          locationId: updated.locationId,
          isActive: updated.employmentStatus === EmploymentStatus.ACTIVE,
        },
      });

      return updated;
    });
  }

  private mapEmployee = (r: Record<string, any>): Employee => ({
    id: r.id,
    employeeNumber: r.employee_number,
    userId: r.user_id ?? null,
    name: r.name,
    position: r.position,
    locationId: r.location_id,
    locationName: r.location_name,
    employmentStatus: r.employment_status,
    joinDate: pgDateToIso(r.join_date),
    phone: r.phone ?? null,
  });
}
