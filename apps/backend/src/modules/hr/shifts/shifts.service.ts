import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import type { CreateShiftDto, UpdateShiftDto, UpsertRosterDto } from '../dto/shift.dto';
import { pgDateToIso } from '../pg-date.util';

export interface ShiftDto {
  id: UUID;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

export interface RosterDay {
  date: string;
  workShiftId: UUID | null;
  shiftName: string | null;
}

export interface RosterRow {
  employeeId: UUID;
  employeeName: string;
  days: RosterDay[];
}

/**
 * M14 `hr` — Shift scheduling (FR-HR-02). `work_shifts` are the reusable
 * templates ("Pagi"/"Sore"/"Malam"); `shift_assignments` is the actual
 * per-employee-per-date roster a supervisor builds for their outlet's staff.
 * Both are class M (cloud-authoritative, pull-only) per SYNC-PROTOCOL §3.3
 * Group 7 — every write here emits a matching sync event.
 */
@Injectable()
export class ShiftsService {
  constructor(private readonly syncEmit: SyncEmitService) {}

  async listShifts(client: PoolClient, locationId?: UUID): Promise<ShiftDto[]> {
    const params: unknown[] = [];
    let where = 'is_active = true';
    if (locationId) {
      params.push(locationId);
      where += ` AND (location_id = $${params.length} OR location_id IS NULL)`;
    }
    const res = await client.query<Record<string, any>>(
      `SELECT * FROM work_shifts WHERE ${where} ORDER BY start_time ASC`,
      params,
    );
    return res.rows.map(this.mapShift);
  }

  async createShift(client: PoolClient, actorUserId: UUID, dto: CreateShiftDto): Promise<ShiftDto> {
    this.assertWindow(dto.startTime, dto.endTime);
    const res = await client.query<Record<string, any>>(
      `INSERT INTO work_shifts (location_id, name, start_time, end_time, break_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [dto.locationId ?? null, dto.name, dto.startTime, dto.endTime, dto.breakMinutes ?? 0],
    );
    const inserted = res.rows[0];
    if (!inserted) {
      // `INSERT ... RETURNING *` failing to return its own just-inserted row is not a business
      // condition (no WHERE clause to fail to match) — a genuine driver/connection fault. Surfacing
      // it as `ERR_INTERNAL` rather than silently proceeding with `undefined` (which is exactly the
      // kind of thing that reaches a payroll input path later as `NaN`/`undefined` derived minutes).
      throw new Error('work_shifts INSERT ... RETURNING * returned no row');
    }
    const shift = this.mapShift(inserted);

    await this.syncEmit.emit(client, {
      entity: 'work_shifts',
      op: 'updated',
      entityId: shift.id,
      locationId: dto.locationId ?? null,
      actorUserId,
      data: { id: shift.id, locationId: dto.locationId ?? null, name: shift.name, startTime: shift.startTime, endTime: shift.endTime, breakMinutes: shift.breakMinutes, isActive: true },
    });

    return shift;
  }

  async updateShift(client: PoolClient, actorUserId: UUID, id: UUID, dto: UpdateShiftDto): Promise<ShiftDto> {
    const existingRes = await client.query<Record<string, any>>('SELECT * FROM work_shifts WHERE id = $1', [id]);
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Shift not found' });

    const nextStart = dto.startTime ?? existing.start_time;
    const nextEnd = dto.endTime ?? existing.end_time;
    if (dto.startTime !== undefined || dto.endTime !== undefined) this.assertWindow(nextStart, nextEnd);

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.locationId !== undefined) set('location_id', dto.locationId);
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.startTime !== undefined) set('start_time', dto.startTime);
    if (dto.endTime !== undefined) set('end_time', dto.endTime);
    if (dto.breakMinutes !== undefined) set('break_minutes', dto.breakMinutes);
    if (dto.isActive !== undefined) set('is_active', dto.isActive);

    let updated: Record<string, any> = existing;
    if (sets.length > 0) {
      params.push(id);
      const res = await client.query<Record<string, any>>(
        `UPDATE work_shifts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      const updatedRow = res.rows[0];
      // The row existed a query ago (checked above) and this UPDATE targets it by primary key with
      // no other predicate — a zero-row RETURNING here means it was deleted concurrently between our
      // SELECT and our UPDATE, a real (if rare) race, not something to paper over with `!`.
      if (!updatedRow) {
        throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Shift not found' });
      }
      updated = updatedRow;
    }
    const shift = this.mapShift(updated);

    await this.syncEmit.emit(client, {
      entity: 'work_shifts',
      op: 'updated',
      entityId: id,
      locationId: updated.location_id ?? null,
      actorUserId,
      data: { id, locationId: updated.location_id ?? null, name: updated.name, startTime: updated.start_time, endTime: updated.end_time, breakMinutes: updated.break_minutes, isActive: updated.is_active },
    });

    return shift;
  }

  async getRoster(client: PoolClient, locationId: UUID, from: string, to: string, employeeId?: UUID): Promise<RosterRow[]> {
    const employeeParams: unknown[] = [locationId];
    let employeeWhere = "e.location_id = $1 AND e.employment_status = 'active'";
    if (employeeId) {
      employeeParams.push(employeeId);
      employeeWhere += ` AND e.id = $${employeeParams.length}`;
    }

    const employeesRes = await client.query<{ id: UUID; name: string }>(
      `SELECT id, name FROM employees e WHERE ${employeeWhere} ORDER BY name ASC`,
      employeeParams,
    );

    const assignmentParams: unknown[] = [locationId, from, to];
    let assignmentsWhere = 'sa.location_id = $1 AND sa.date BETWEEN $2 AND $3';
    if (employeeId) {
      assignmentParams.push(employeeId);
      assignmentsWhere += ` AND sa.employee_id = $${assignmentParams.length}`;
    }

    const assignmentsRes = await client.query<Record<string, any>>(
      `SELECT sa.employee_id, sa.date, sa.work_shift_id, ws.name AS shift_name
         FROM shift_assignments sa
         LEFT JOIN work_shifts ws ON ws.id = sa.work_shift_id
        WHERE ${assignmentsWhere}`,
      assignmentParams,
    );

    const byEmployee = new Map<UUID, RosterDay[]>();
    for (const row of assignmentsRes.rows) {
      const list = byEmployee.get(row.employee_id) ?? [];
      list.push({ date: pgDateToIso(row.date), workShiftId: row.work_shift_id ?? null, shiftName: row.shift_name ?? null });
      byEmployee.set(row.employee_id, list);
    }

    return employeesRes.rows.map((e) => ({
      employeeId: e.id,
      employeeName: e.name,
      days: byEmployee.get(e.id) ?? [],
    }));
  }

  async upsertRoster(client: PoolClient, actorUserId: UUID, dto: UpsertRosterDto): Promise<{ updated: number }> {
    for (const a of dto.assignments) {
      const res = await client.query<{ id: UUID }>(
        `INSERT INTO shift_assignments (employee_id, work_shift_id, location_id, date, assigned_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, date) DO UPDATE SET
           work_shift_id = $2, location_id = $3, assigned_by = $5, updated_at = NOW()
         RETURNING id`,
        [a.employeeId, a.workShiftId ?? null, dto.locationId, a.date, actorUserId],
      );
      const assignmentId = res.rows[0]!.id;

      await this.syncEmit.emit(client, {
        entity: 'shift_assignments',
        op: a.workShiftId ? 'changed' : 'removed',
        entityId: assignmentId,
        locationId: dto.locationId,
        actorUserId,
        data: { id: assignmentId, employeeId: a.employeeId, workShiftId: a.workShiftId ?? null, locationId: dto.locationId, date: a.date },
      });
    }
    return { updated: dto.assignments.length };
  }

  private assertWindow(startTime: string, endTime: string): void {
    if (startTime === endTime) {
      throw new BadRequestException({ code: 'ERR_VALIDATION', message: 'startTime and endTime cannot be equal' });
    }
  }

  private mapShift = (r: Record<string, any>): ShiftDto => ({
    id: r.id,
    name: r.name,
    startTime: typeof r.start_time === 'string' ? r.start_time.slice(0, 5) : r.start_time,
    endTime: typeof r.end_time === 'string' ? r.end_time.slice(0, 5) : r.end_time,
    breakMinutes: r.break_minutes,
  });
}
