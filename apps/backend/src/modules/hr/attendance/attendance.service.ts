import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  businessDateOf,
  ERR_CONFLICT,
  ERR_GEOFENCE_OUT_OF_RANGE,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  lateMinutes as computeLateMinutes,
  overtimeMinutes as computeOvertimeMinutes,
  shiftWindow,
  workedMinutes,
  type AttendanceRow,
  type ISODateTime,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { checkGeofence } from '../geofence.util';
import {
  getDefaultGeofenceRadiusM,
  getLateGraceMinutes,
  getMaxOfflineWindowHours,
  getOvertimeSettings,
} from '../hr-settings.util';
import { pgDateToIso } from '../pg-date.util';
import { resolveDefensibility } from '../time-defensibility.util';
import type {
  CheckAttendanceDto,
  CorrectAttendanceDto,
  MarkAbsentDto,
} from '../dto/attendance.dto';
import { StorageService } from '../../../kernel/storage/storage.service';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { withWrite } from '../db-tx';

/**
 * A rostered working day with no attendance record of any kind — see
 * `AttendanceService.listNoShows`.
 *
 * Carries the roster side of the day (shift name, branch) rather than an
 * attendance id, because there is no attendance row: that is the whole point.
 */
export interface NoShowRow {
  employeeId: UUID;
  employeeNumber: string;
  employeeName: string;
  locationId: UUID;
  locationName: string;
  date: string;
  shiftName: string;
  shiftAssignmentId: UUID;
}

export interface AttendanceSummaryRow {
  employeeId: UUID;
  presentDays: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  sickDays: number;
  permissionDays: number;
  absentDays: number;
  leaveDays: number;
  disputedRows: number;
}

/** Postgres `TIME` columns round-trip as `'HH:mm:ss'` through `pg` — `shiftWindow()` (`@mimi/shared`) expects `'HH:mm'`. */
function toHHmm(time: string): string {
  return time.slice(0, 5);
}

interface ResolvedShift {
  shiftAssignmentId: UUID;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

/**
 * M14 `hr` — Attendance (FR-HR-01: GPS geofence + selfie; FR-HR-03 inputs to
 * M15 payroll). Ticket / SYNC-PROTOCOL §6: attendance can be captured
 * offline on a personal phone whose clock the employee controls — see
 * `time-defensibility.util.ts` for the `defensibleAt` clamp this service
 * applies before deriving lateness/overtime, and its header comment for why
 * this REST endpoint (the online-direct path, SYNC-PROTOCOL §1.3) does NOT
 * call `SyncEmitService`: `attendance` is class F (push-only, edge-authored
 * by protocol design) — `SyncEmitService.emit()` deliberately rejects any
 * entity whose direction isn't `pull`/`bidirectional` (see that file's
 * guard), so a push-only fact authored directly on the cloud tier needs no
 * further "sync" of itself. The `client_id` / `check_out_client_id` UNIQUE
 * columns are what let a LATER genuine offline replay of the same action
 * (once the frontend's local-first runtime, W2-E/F11, exists) converge on
 * this same row instead of double-counting it.
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly storage: StorageService) {}

  async checkIn(
    client: PoolClient,
    user: JwtAccessPayload,
    dto: CheckAttendanceDto,
  ): Promise<AttendanceRow> {
    const employee = await this.resolveSelfEmployee(client, user.sub);
    return withWrite(client, async () => {
      const row = await this.applyCheckIn(client, employee.id, dto, new Date().toISOString());
      return this.toAttendanceRow(client, user, row);
    });
  }

  async checkOut(
    client: PoolClient,
    user: JwtAccessPayload,
    dto: CheckAttendanceDto,
  ): Promise<AttendanceRow> {
    const employee = await this.resolveSelfEmployee(client, user.sub);
    return withWrite(client, async () => {
      const row = await this.applyCheckOut(client, employee.id, dto, new Date().toISOString());
      return this.toAttendanceRow(client, user, row);
    });
  }

  /**
   * The shared derivation core for `checked_in` — called by the ONLINE REST
   * path above (`relayReceivedAt = new Date()`, this request's own arrival)
   * AND by `AttendanceSyncProjector` (`relayReceivedAt` = the fact's real
   * first server sighting, read back from `sync_events.relay_received_at`).
   * Both paths derive `time_suspect`/`time_disputed`/lateness identically —
   * PIN-02/POUT-07 must not silently diverge depending on whether the
   * outlet had internet that day (coordinator's instruction).
   */
  async applyCheckIn(
    client: PoolClient,
    employeeId: UUID,
    dto: CheckAttendanceDto,
    relayReceivedAt: ISODateTime,
  ): Promise<Record<string, any>> {
    const location = await this.resolveLocation(client, dto.locationId);

    const occurredAt = dto.at ?? relayReceivedAt;
    const maxOfflineWindowHours = await getMaxOfflineWindowHours(client);
    const defensibility = resolveDefensibility(occurredAt, relayReceivedAt, maxOfflineWindowHours);
    const lateInstant = defensibility.timeDisputed ? defensibility.defensibleAt : occurredAt;
    const date = businessDateOf(
      defensibility.timeSuspect ? defensibility.defensibleAt : occurredAt,
    );

    // Idempotent replay: the exact same client_id already landed — return it as-is (§2.2 outbox rule).
    const existingByClient = await client.query<Record<string, any>>(
      'SELECT * FROM attendance WHERE client_id = $1',
      [dto.clientId],
    );
    if (existingByClient.rows.length > 0) {
      return existingByClient.rows[0]!;
    }

    const existingByDay = await client.query<{ id: UUID; check_in_at: ISODateTime | null }>(
      'SELECT id, check_in_at FROM attendance WHERE employee_id = $1 AND date = $2',
      [employeeId, date],
    );
    if (existingByDay.rows.length > 0 && existingByDay.rows[0]!.check_in_at) {
      // SYNC-PROTOCOL §5.2 C4: a second check-in the same day is an HR exception, not a silent overwrite.
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: 'Employee already checked in today',
      });
    }

    const distance = checkGeofence(
      Number(dto.lat),
      Number(dto.lng),
      Number(location.latitude),
      Number(location.longitude),
      location.geofenceRadiusM,
    );
    if (!distance.ok) {
      throw new BadRequestException({
        code: ERR_GEOFENCE_OUT_OF_RANGE,
        message: `Check-in is ${distance.distanceM}m from the outlet, outside the ${location.geofenceRadiusM}m geofence`,
        details: { distanceM: distance.distanceM, radiusM: location.geofenceRadiusM },
      });
    }

    await this.assertAttachmentExists(client, dto.selfieAttachmentId);

    const shift = await this.resolveShiftAssignment(client, employeeId, date);
    const graceMinutes = await getLateGraceMinutes(client);
    let lateM = 0;
    if (shift) {
      const window = shiftWindow(date, shift.startTime, shift.endTime, shift.breakMinutes);
      lateM = computeLateMinutes(window.startUtc, lateInstant, graceMinutes);
    }
    const status = lateM > 0 ? 'late' : 'present';

    const rowId = existingByDay.rows[0]?.id;
    const res = rowId
      ? await client.query<Record<string, any>>(
          `UPDATE attendance SET
             shift_assignment_id = $2, check_in_at = $3, check_in_lat = $4, check_in_lng = $5,
             check_in_distance_m = $6, check_in_selfie_attachment_id = $7, check_in_device_id = $8,
             status = $9, late_minutes = $10, geofence_ok = $11, client_id = $12,
             time_suspect = $13, time_disputed = $14, check_in_received_at = $15
           WHERE id = $1 RETURNING *`,
          [
            rowId,
            shift?.shiftAssignmentId ?? null,
            occurredAt,
            dto.lat,
            dto.lng,
            distance.distanceM,
            dto.selfieAttachmentId,
            dto.deviceId ?? null,
            status,
            lateM,
            distance.ok,
            dto.clientId,
            defensibility.timeSuspect,
            defensibility.timeDisputed,
            relayReceivedAt,
          ],
        )
      : await client.query<Record<string, any>>(
          `INSERT INTO attendance
             (employee_id, location_id, date, shift_assignment_id, check_in_at, check_in_lat, check_in_lng,
              check_in_distance_m, check_in_selfie_attachment_id, check_in_device_id, status, late_minutes,
              geofence_ok, client_id, time_suspect, time_disputed, check_in_received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING *`,
          [
            employeeId,
            dto.locationId,
            date,
            shift?.shiftAssignmentId ?? null,
            occurredAt,
            dto.lat,
            dto.lng,
            distance.distanceM,
            dto.selfieAttachmentId,
            dto.deviceId ?? null,
            status,
            lateM,
            distance.ok,
            dto.clientId,
            defensibility.timeSuspect,
            defensibility.timeDisputed,
            relayReceivedAt,
          ],
        );

    return res.rows[0]!;
  }

  /** The `checked_out` counterpart of `applyCheckIn` — same sharing rationale. */
  async applyCheckOut(
    client: PoolClient,
    employeeId: UUID,
    dto: CheckAttendanceDto,
    relayReceivedAt: ISODateTime,
  ): Promise<Record<string, any>> {
    const location = await this.resolveLocation(client, dto.locationId);

    const occurredAt = dto.at ?? relayReceivedAt;
    const maxOfflineWindowHours = await getMaxOfflineWindowHours(client);
    const defensibility = resolveDefensibility(occurredAt, relayReceivedAt, maxOfflineWindowHours);
    const outInstant = defensibility.timeDisputed ? defensibility.defensibleAt : occurredAt;
    const date = businessDateOf(
      defensibility.timeSuspect ? defensibility.defensibleAt : occurredAt,
    );

    const existingByClient = await client.query<Record<string, any>>(
      'SELECT * FROM attendance WHERE check_out_client_id = $1',
      [dto.clientId],
    );
    if (existingByClient.rows.length > 0) {
      return existingByClient.rows[0]!;
    }

    const rowRes = await client.query<Record<string, any>>(
      'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2',
      [employeeId, date],
    );
    const row = rowRes.rows[0];
    if (!row || !row.check_in_at) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'No check-in found for this date — check in before checking out',
      });
    }
    if (row.check_out_at) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: 'Employee already checked out today',
      });
    }

    const distance = checkGeofence(
      Number(dto.lat),
      Number(dto.lng),
      Number(location.latitude),
      Number(location.longitude),
      location.geofenceRadiusM,
    );
    if (!distance.ok) {
      throw new BadRequestException({
        code: ERR_GEOFENCE_OUT_OF_RANGE,
        message: `Check-out is ${distance.distanceM}m from the outlet, outside the ${location.geofenceRadiusM}m geofence`,
        details: { distanceM: distance.distanceM, radiusM: location.geofenceRadiusM },
      });
    }

    await this.assertAttachmentExists(client, dto.selfieAttachmentId);

    let overtimeM = 0;
    let workM = workedMinutes(row.check_in_at, outInstant, 0);
    if (row.shift_assignment_id) {
      const shiftRes = await client.query<{
        start_time: string;
        end_time: string;
        break_minutes: number;
      }>(
        `SELECT ws.start_time, ws.end_time, ws.break_minutes
           FROM shift_assignments sa JOIN work_shifts ws ON ws.id = sa.work_shift_id
          WHERE sa.id = $1`,
        [row.shift_assignment_id],
      );
      if (shiftRes.rows.length > 0) {
        const s = shiftRes.rows[0]!;
        const overtimeSettings = await getOvertimeSettings(client);
        const window = shiftWindow(date, toHHmm(s.start_time), toHHmm(s.end_time), s.break_minutes);
        overtimeM = computeOvertimeMinutes(window.endUtc, outInstant, overtimeSettings.minMinutes);
        workM = workedMinutes(row.check_in_at, outInstant, s.break_minutes);
      }
    }

    const res = await client.query<Record<string, any>>(
      `UPDATE attendance SET
         check_out_at = $2, check_out_lat = $3, check_out_lng = $4, check_out_distance_m = $5,
         check_out_selfie_attachment_id = $6, overtime_minutes = $7, work_minutes = $8,
         check_out_client_id = $9, time_suspect = (time_suspect OR $10), time_disputed = (time_disputed OR $11),
         check_out_received_at = $12
       WHERE id = $1 RETURNING *`,
      [
        row.id,
        occurredAt,
        dto.lat,
        dto.lng,
        distance.distanceM,
        dto.selfieAttachmentId,
        overtimeM,
        workM,
        dto.clientId,
        defensibility.timeSuspect,
        defensibility.timeDisputed,
        relayReceivedAt,
      ],
    );

    return res.rows[0]!;
  }

  async correct(
    client: PoolClient,
    user: JwtAccessPayload,
    id: UUID,
    dto: CorrectAttendanceDto,
  ): Promise<AttendanceRow> {
    const actorUserId = user.sub;
    if (!dto.correctionReason?.trim()) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'correctionReason is required',
      });
    }
    const rowRes = await client.query<Record<string, any>>(
      'SELECT * FROM attendance WHERE id = $1',
      [id],
    );
    if (rowRes.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Attendance row not found' });
    const row = rowRes.rows[0]!;

    return withWrite(client, async () => {
      const sets: string[] = ['corrected_by = $1', 'correction_reason = $2'];
      const params: unknown[] = [actorUserId, dto.correctionReason];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.status !== undefined) set('status', dto.status);
      if (dto.checkInAt !== undefined) set('check_in_at', dto.checkInAt);
      if (dto.checkOutAt !== undefined) set('check_out_at', dto.checkOutAt);

      const checkInAt = dto.checkInAt ?? row.check_in_at;
      const checkOutAt = dto.checkOutAt ?? row.check_out_at;
      if (
        (dto.checkInAt !== undefined || dto.checkOutAt !== undefined) &&
        row.shift_assignment_id
      ) {
        const shiftRes = await client.query<{
          start_time: string;
          end_time: string;
          break_minutes: number;
        }>(
          `SELECT ws.start_time, ws.end_time, ws.break_minutes
             FROM shift_assignments sa JOIN work_shifts ws ON ws.id = sa.work_shift_id
            WHERE sa.id = $1`,
          [row.shift_assignment_id],
        );
        if (shiftRes.rows.length > 0) {
          const s = shiftRes.rows[0]!;
          const window = shiftWindow(
            pgDateToIso(row.date),
            toHHmm(s.start_time),
            toHHmm(s.end_time),
            s.break_minutes,
          );
          const graceMinutes = await getLateGraceMinutes(client);
          if (checkInAt)
            set('late_minutes', computeLateMinutes(window.startUtc, checkInAt, graceMinutes));
          if (checkOutAt) {
            const overtimeSettings = await getOvertimeSettings(client);
            set(
              'overtime_minutes',
              computeOvertimeMinutes(window.endUtc, checkOutAt, overtimeSettings.minMinutes),
            );
          }
          if (checkInAt && checkOutAt)
            set('work_minutes', workedMinutes(checkInAt, checkOutAt, s.break_minutes));
        }
      }

      params.push(id);
      const res = await client.query<Record<string, any>>(
        `UPDATE attendance SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return this.toAttendanceRow(client, user, res.rows[0]!);
    });
  }

  async listMe(
    client: PoolClient,
    user: JwtAccessPayload,
    month?: string,
  ): Promise<AttendanceRow[]> {
    const employee = await this.resolveSelfEmployee(client, user.sub);
    const params: unknown[] = [employee.id];
    let where = 'a.employee_id = $1';
    if (month) {
      params.push(`${month}-01`);
      where += ` AND date_trunc('month', a.date) = date_trunc('month', $${params.length}::date)`;
    }
    const res = await client.query<Record<string, any>>(
      `SELECT a.* FROM attendance a WHERE ${where} ORDER BY a.date DESC`,
      params,
    );
    return Promise.all(res.rows.map((r) => this.toAttendanceRow(client, user, r)));
  }

  async list(
    client: PoolClient,
    user: JwtAccessPayload,
    locationId: string | undefined,
    date: string | undefined,
    employeeId: string | undefined,
    status: string | undefined,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<AttendanceRow>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (locationId) {
      params.push(locationId);
      where += ` AND a.location_id = $${params.length}`;
    }
    if (date) {
      params.push(date);
      where += ` AND a.date = $${params.length}`;
    }
    if (employeeId) {
      params.push(employeeId);
      where += ` AND a.employee_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM attendance a WHERE ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<Record<string, any>>(
      `SELECT a.* FROM attendance a WHERE ${where} ORDER BY a.date DESC, a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: await Promise.all(res.rows.map((r) => this.toAttendanceRow(client, user, r))),
      total,
      page,
      pageSize,
    };
  }

  /**
   * ROSTERED DAYS NOBODY EVER RECORDED — the gap MA-200 surfaced.
   *
   * An `attendance` row is created by a CHECK-IN and nothing else
   * (`applyCheckIn`), and `correct` updates `WHERE attendance.id = $1`. So an
   * employee who was rostered and did not turn up leaves no trace at all:
   * there is no row to correct, and until `markAbsent` below there was no way
   * anywhere in the product to record the fact. `attendance.status = 'absent'`
   * was never written by any code path — the only two references to it in the
   * backend were `COUNT(*) FILTER (WHERE a.status = 'absent')` here and the
   * matching one in `RunsService.buildBaseInputs`, so `deduction_absence`
   * (POUT-03) was unreachable and every payroll run showed Rp0 of
   * attendance-driven deductions.
   *
   * This is the worklist that closes it. Deliberately a LIST and not an
   * automatic deduction: a rostered day with no attendance row means "no
   * evidence either way", and on this deployment the usual cause is that the
   * offline outbox has not drained rather than that anyone stayed home.
   * Deriving the deduction here instead was written and measured before being
   * rejected — on the seeded database that rule turns 7,701 rostered working
   * days holding 126 attendance records into a month's absence deduction for
   * nearly the whole roster. A payroll that converts a sync failure into lost
   * pay is much worse than one that shows a zero.
   *
   *  - `work_shift_id IS NOT NULL` — a NULL assignment is 'libur' (migration
   *    061), a scheduled day off, not a day anybody failed to attend.
   *  - `sa.date < CURRENT_DATE` — a day still in progress is not yet a
   *    no-show.
   *  - approved leave is excluded: a granted absence is not an unexplained one.
   */
  async listNoShows(
    client: PoolClient,
    query: {
      locationId?: string;
      from: string;
      to: string;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<NoShowRow>> {
    const params: unknown[] = [query.from, query.to];
    let where = `sa.work_shift_id IS NOT NULL
          AND sa.date >= $1::date AND sa.date <= $2::date
          AND sa.date < CURRENT_DATE
          AND NOT EXISTS (
                SELECT 1 FROM attendance a
                 WHERE a.employee_id = sa.employee_id AND a.date = sa.date)
          AND NOT EXISTS (
                SELECT 1 FROM leave_requests lr
                 WHERE lr.employee_id = sa.employee_id
                   AND lr.status = 'approved'
                   AND sa.date BETWEEN lr.start_date AND lr.end_date)`;
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND sa.location_id = $${params.length}`;
    }

    const fromSql = `FROM shift_assignments sa
         JOIN employees e ON e.id = sa.employee_id
         JOIN locations l ON l.id = sa.location_id
         JOIN work_shifts ws ON ws.id = sa.work_shift_id`;

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count ${fromSql} WHERE ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const res = await client.query<Record<string, any>>(
      `SELECT sa.id AS shift_assignment_id, sa.employee_id, sa.date, sa.location_id,
              e.name AS employee_name, e.employee_number, l.name AS location_name,
              ws.name AS shift_name
         ${fromSql}
        WHERE ${where}
        ORDER BY sa.date DESC, e.name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map((r) => ({
        employeeId: r.employee_id,
        employeeNumber: r.employee_number,
        employeeName: r.employee_name,
        locationId: r.location_id,
        locationName: r.location_name,
        date: pgDateToIso(r.date),
        shiftName: r.shift_name,
        shiftAssignmentId: r.shift_assignment_id,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Record that a rostered employee did not turn up — the write half of
   * `listNoShows`, and the only code path in this system that produces
   * `attendance.status = 'absent'`.
   *
   * Creates the row a no-show never left behind, which is what makes POUT-03's
   * `deduction_absence` computable at all. `correctionReason` is required for
   * the same reason `correct` requires it: this costs the employee a day's
   * pay, so FR-AUDIT-02 wants a named person and a stated reason, not a bare
   * status.
   *
   * Every guard refuses rather than overwrites. `UNIQUE (employee_id, date)`
   * already makes a second call an error, but somebody re-submitting a
   * worklist deserves to be told which day was already handled, and how,
   * rather than a constraint violation.
   */
  async markAbsent(
    client: PoolClient,
    user: JwtAccessPayload,
    dto: MarkAbsentDto,
  ): Promise<AttendanceRow> {
    if (!dto.correctionReason?.trim()) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'correctionReason is required',
      });
    }

    const rosterRes = await client.query<{ id: UUID; location_id: UUID }>(
      `SELECT sa.id, sa.location_id
         FROM shift_assignments sa
        WHERE sa.employee_id = $1 AND sa.date = $2::date AND sa.work_shift_id IS NOT NULL`,
      [dto.employeeId, dto.date],
    );
    const roster = rosterRes.rows[0];
    if (!roster) {
      // Not rostered at all, or rostered as 'libur'. Either way nobody was
      // expected, so there is nothing to be absent from — and a deduction here
      // would be for a day the employee was never asked to work.
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'That employee was not rostered to a working shift on that date',
      });
    }

    const existing = await client.query<{ status: string }>(
      'SELECT status FROM attendance WHERE employee_id = $1 AND date = $2::date',
      [dto.employeeId, dto.date],
    );
    if (existing.rows[0]) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `That day already has an attendance record ('${existing.rows[0].status}') — correct that row instead`,
      });
    }

    const leave = await client.query<{ type: string }>(
      `SELECT type FROM leave_requests
        WHERE employee_id = $1 AND status = 'approved' AND $2::date BETWEEN start_date AND end_date`,
      [dto.employeeId, dto.date],
    );
    if (leave.rows[0]) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `That day is covered by approved leave ('${leave.rows[0].type}') — an authorised absence is not an unexplained one`,
      });
    }

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `INSERT INTO attendance
           (employee_id, location_id, date, shift_assignment_id, status, corrected_by, correction_reason)
         VALUES ($1,$2,$3::date,$4,'absent',$5,$6)
         RETURNING *`,
        [dto.employeeId, roster.location_id, dto.date, roster.id, user.sub, dto.correctionReason],
      );
      return this.toAttendanceRow(client, user, res.rows[0]!);
    });
  }

  /**
   * The payroll input this ticket exposes for M15 (FR-HR-03/04, POUT-01/02/03/07/08).
   * `periodCode` is `'YYYY-MM'`; `disputedRows` surfaces §6.4 `time_disputed` rows for
   * a payroll operator to review before trusting a period's lateness/overtime totals.
   */
  async summary(
    client: PoolClient,
    periodCode: string,
    locationId?: string,
    employeeId?: string,
  ): Promise<AttendanceSummaryRow[]> {
    const match = /^(\d{4})-(\d{2})$/.exec(periodCode);
    if (!match)
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: "periodCode must be 'YYYY-MM'",
      });
    const startDate = `${match[1]}-${match[2]}-01`;

    const params: unknown[] = [startDate];
    let where = "a.date >= $1::date AND a.date < ($1::date + INTERVAL '1 month')";
    if (locationId) {
      params.push(locationId);
      where += ` AND a.location_id = $${params.length}`;
    }
    if (employeeId) {
      params.push(employeeId);
      where += ` AND a.employee_id = $${params.length}`;
    }

    const res = await client.query<Record<string, any>>(
      `SELECT
         a.employee_id,
         COUNT(*) FILTER (WHERE a.status IN ('present','late')) AS present_days,
         COUNT(*) FILTER (WHERE a.status = 'late') AS late_count,
         COALESCE(SUM(a.late_minutes), 0) AS late_minutes,
         COALESCE(SUM(a.overtime_minutes), 0) AS overtime_minutes,
         COUNT(*) FILTER (WHERE a.status = 'sick') AS sick_days,
         COUNT(*) FILTER (WHERE a.status = 'permission') AS permission_days,
         COUNT(*) FILTER (WHERE a.status = 'absent') AS absent_days,
         COUNT(*) FILTER (WHERE a.status = 'leave') AS leave_days,
         COUNT(*) FILTER (WHERE a.time_disputed) AS disputed_rows
       FROM attendance a
       WHERE ${where}
       GROUP BY a.employee_id`,
      params,
    );

    return res.rows.map((r) => ({
      employeeId: r.employee_id,
      presentDays: parseInt(r.present_days, 10),
      lateCount: parseInt(r.late_count, 10),
      lateMinutes: parseInt(r.late_minutes, 10),
      overtimeMinutes: parseInt(r.overtime_minutes, 10),
      sickDays: parseInt(r.sick_days, 10),
      permissionDays: parseInt(r.permission_days, 10),
      absentDays: parseInt(r.absent_days, 10),
      leaveDays: parseInt(r.leave_days, 10),
      disputedRows: parseInt(r.disputed_rows, 10),
    }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Public — also used by `AttendanceSyncProjector` to resolve `event.actorUserId` -> employee. */
  async resolveSelfEmployee(
    client: PoolClient,
    userId: UUID,
  ): Promise<{ id: UUID; locationId: UUID }> {
    const res = await client.query<{ id: UUID; location_id: UUID }>(
      'SELECT id, location_id FROM employees WHERE user_id = $1',
      [userId],
    );
    if (res.rows.length === 0) {
      throw new ForbiddenException({
        code: ERR_VALIDATION,
        message: 'This account has no linked employee record',
      });
    }
    return { id: res.rows[0]!.id, locationId: res.rows[0]!.location_id };
  }

  /**
   * The location's geofence centre and its EFFECTIVE radius.
   *
   * `locations.geofence_radius_m` is nullable as of migration 229: NULL means
   * inherit `settings('hr.geofence_radius_m')` (200 m — owner, 2026-08-21) and
   * a number means this outlet was deliberately overridden. Resolved here so
   * check-in and check-out cannot drift apart, and so the number the Absen
   * screen displays is the number this endpoint will enforce.
   */
  private async resolveLocation(
    client: PoolClient,
    locationId: UUID,
  ): Promise<{ latitude: string; longitude: string; geofenceRadiusM: number }> {
    const res = await client.query<{
      latitude: string | null;
      longitude: string | null;
      geofence_radius_m: number | null;
    }>('SELECT latitude, longitude, geofence_radius_m FROM locations WHERE id = $1', [locationId]);
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Location not found' });
    const row = res.rows[0]!;
    if (row.latitude === null || row.longitude === null) {
      // Without a centre there is no fence to measure against, and inventing
      // one would either lock everyone out or let anyone clock in from home.
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'This location has no geofence center configured',
      });
    }
    return {
      latitude: row.latitude,
      longitude: row.longitude,
      geofenceRadiusM: row.geofence_radius_m ?? (await getDefaultGeofenceRadiusM(client)),
    };
  }

  private async assertAttachmentExists(client: PoolClient, attachmentId: UUID): Promise<void> {
    const res = await client.query('SELECT id FROM attachments WHERE id = $1', [attachmentId]);
    if (res.rows.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'selfieAttachmentId does not reference an uploaded attachment',
      });
    }
  }

  private async resolveShiftAssignment(
    client: PoolClient,
    employeeId: UUID,
    date: string,
  ): Promise<ResolvedShift | null> {
    const res = await client.query<{
      id: UUID;
      start_time: string;
      end_time: string;
      break_minutes: number;
      work_shift_id: UUID | null;
    }>(
      `SELECT sa.id, sa.work_shift_id, ws.start_time, ws.end_time, ws.break_minutes
         FROM shift_assignments sa
         LEFT JOIN work_shifts ws ON ws.id = sa.work_shift_id
        WHERE sa.employee_id = $1 AND sa.date = $2`,
      [employeeId, date],
    );
    const row = res.rows[0];
    if (!row || !row.work_shift_id) return null;
    return {
      shiftAssignmentId: row.id,
      startTime: toHHmm(row.start_time),
      endTime: toHHmm(row.end_time),
      breakMinutes: row.break_minutes,
    };
  }

  /**
   * Best-effort presigned URL — a MinIO hiccup on a LIST/read path must not
   * 500 the whole page. Takes the CALLER's own `PoolClient` (D-21/D-22:
   * `StorageService.getUrl()` needs a role-switched connection — `mimi_app`
   * holds no table grants of its own — and `toAttendanceRow`'s caller
   * already has one open for this request).
   */
  private async safeSelfieUrl(
    client: PoolClient,
    user: JwtAccessPayload,
    attachmentId: UUID | null,
  ): Promise<string | null> {
    if (!attachmentId) return null;
    try {
      const { url } = await this.storage.getUrl(client, user, null, attachmentId);
      return url;
    } catch {
      return null;
    }
  }

  private async toAttendanceRow(
    client: PoolClient,
    user: JwtAccessPayload,
    r: Record<string, any>,
  ): Promise<AttendanceRow> {
    const empRes = await client.query<{ name: string }>(
      'SELECT name FROM employees WHERE id = $1',
      [r.employee_id],
    );
    const locRes = await client.query<{ name: string }>(
      'SELECT name FROM locations WHERE id = $1',
      [r.location_id],
    );
    const [inUrl, outUrl] = await Promise.all([
      this.safeSelfieUrl(client, user, r.check_in_selfie_attachment_id ?? null),
      this.safeSelfieUrl(client, user, r.check_out_selfie_attachment_id ?? null),
    ]);

    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeName: empRes.rows[0]?.name ?? '',
      locationName: locRes.rows[0]?.name ?? '',
      date: pgDateToIso(r.date),
      status: r.status,
      checkInAt: r.check_in_at ?? null,
      checkOutAt: r.check_out_at ?? null,
      lateMinutes: r.late_minutes ?? 0,
      overtimeMinutes: r.overtime_minutes ?? 0,
      geofenceOk: r.geofence_ok ?? true,
      selfieUrls: { in: inUrl, out: outUrl },
      timeSuspect: r.time_suspect ?? false,
    };
  }
}
