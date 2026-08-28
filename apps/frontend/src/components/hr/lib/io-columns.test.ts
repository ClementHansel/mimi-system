/**
 * Pins `employeeIoColumns`' headers against the BACKEND importer's `employees`
 * column list (`apps/backend/src/modules/import/import-schema.ts`), same
 * reasoning as `components/purchasing/lib/io-columns.test.ts`: the frontend
 * cannot import that file (separate package), so the literals below are
 * transcribed from it and this test is what names any future drift.
 *
 * The other exports here (`ATTENDANCE_EXPORT_COLUMNS`, `LEAVE_EXPORT_COLUMNS`,
 * `workShiftIoColumns`, `rosterExportColumns`, the four statutory
 * tables, payroll) are report-only and never claim to mirror an importer, so
 * they are covered by decimal/blank-handling assertions instead of a header
 * pin.
 */
import { describe, it, expect } from 'vitest';
import {
  employeeIoColumns,
  ATTENDANCE_EXPORT_COLUMNS,
  LEAVE_EXPORT_COLUMNS,
  PAYSLIP_EXPORT_COLUMNS,
  BPJS_EXPORT_COLUMNS,
  rosterExportColumns,
  workShiftIoColumns,
} from './io-columns';
import { toCsv } from '@/lib/export/csv';
import type { AttendanceRow, Leave, Payslip, RosterRow, WorkShift } from './types';
import type { EmployeeExportRow } from './io-columns';

describe('employeeIoColumns', () => {
  it("matches the importer's `employees` columns, in order", () => {
    const headers = employeeIoColumns(new Map()).map((c) => c.header);
    expect(headers).toEqual([
      'employee_number',
      'name',
      'position',
      'location',
      'join_date',
      'base_salary',
      'nik',
      'phone',
      'email',
    ]);
  });

  const EMPLOYEE: EmployeeExportRow = {
    id: 'e1',
    employeeNumber: 'EMP001',
    userId: null,
    name: 'Budi Santoso',
    position: 'Kasir',
    locationId: 'loc-1',
    locationName: 'Gudang',
    employmentStatus: 'active',
    joinDate: '2026-01-15',
    phone: '081234567890',
    nik: '6371011501900001',
    email: 'budi@mimichicken.id',
    baseSalary: '3500000.00',
  };

  it('resolves `location` to the CODE via the id→code lookup, never the name', () => {
    const csv = toCsv([EMPLOYEE], employeeIoColumns(new Map([['loc-1', 'GDG']])));
    expect(csv).toContain('GDG');
    expect(csv).not.toContain('Gudang');
  });

  it('leaves `location` blank rather than guessing when the id is unmapped', () => {
    const csv = toCsv([EMPLOYEE], employeeIoColumns(new Map()));
    const [, row] = csv.split('\r\n');
    expect(row?.split(',')[3]).toBe('');
  });

  it('keeps `base_salary` as a verbatim decimal string', () => {
    const csv = toCsv([EMPLOYEE], employeeIoColumns(new Map([['loc-1', 'GDG']])));
    expect(csv).toContain('3500000.00');
    expect(csv).not.toContain('Rp');
  });

  it('writes blanks, never the literal "null", for absent optionals', () => {
    const bare: EmployeeExportRow = { ...EMPLOYEE, nik: null, email: null, phone: null };
    const csv = toCsv([bare], employeeIoColumns(new Map([['loc-1', 'GDG']])));
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('round-trips: the exported header row IS an importable header row', () => {
    const csv = toCsv([EMPLOYEE], employeeIoColumns(new Map([['loc-1', 'GDG']])));
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe(
      'employee_number,name,position,location,join_date,base_salary,nik,phone,email',
    );
  });
});

describe('report-only hr columns', () => {
  const ATTENDANCE: AttendanceRow = {
    id: 'a1',
    employeeId: 'e1',
    employeeName: 'Budi Santoso',
    locationName: 'Gudang',
    date: '2026-08-20',
    status: 'present',
    checkInAt: '2026-08-20T00:00:00.000Z',
    checkOutAt: null,
    lateMinutes: 0,
    overtimeMinutes: 0,
    geofenceOk: true,
    selfieUrls: { in: null, out: null },
    timeSuspect: false,
  };

  it('does not mirror the importer header names (this is a report, not an import file)', () => {
    const headers = ATTENDANCE_EXPORT_COLUMNS.map((c) => c.header);
    expect(headers).not.toContain('employee_number');
  });

  it('writes blank, never "null", for an unset checkout', () => {
    const csv = toCsv([ATTENDANCE], ATTENDANCE_EXPORT_COLUMNS);
    expect(csv).not.toContain('null');
  });

  const LEAVE: Leave = {
    id: 'l1',
    employeeName: 'Budi Santoso',
    type: 'annual',
    startDate: '2026-08-20',
    endDate: '2026-08-21',
    days: '2',
    reason: null,
    status: 'pending',
    attachmentUrl: null,
    decidedBy: null,
  };

  it('keeps `days` as a verbatim decimal string (half-day leave is real)', () => {
    const half: Leave = { ...LEAVE, days: '0.5' };
    const csv = toCsv([half], LEAVE_EXPORT_COLUMNS);
    expect(csv).toContain('0.5');
  });

  const PAYSLIP: Payslip = {
    runId: 'r1',
    periodCode: '2026-08',
    employee: { id: 'e1', name: 'Budi Santoso', position: 'Kasir', locationName: 'Gudang' },
    lines: [],
    gross: '4000000.00',
    deductions: '150000.00',
    net: '3850000.00',
    employerCost: '4200000.00',
    slipPdfUrl: null,
  };

  it('keeps every payslip money field a verbatim decimal string', () => {
    const csv = toCsv([PAYSLIP], PAYSLIP_EXPORT_COLUMNS);
    expect(csv).toContain('4000000.00');
    expect(csv).toContain('150000.00');
    expect(csv).toContain('3850000.00');
    expect(csv).toContain('4200000.00');
    expect(csv).not.toContain('Rp');
  });

  it('BPJS export leaves floor/cap blank rather than "null" when unset', () => {
    const row = {
      id: 'b1',
      program: 'kesehatan' as const,
      employerPct: '4.000',
      employeePct: '1.000',
      salaryFloor: null,
      salaryCap: null,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    };
    const csv = toCsv([row], BPJS_EXPORT_COLUMNS);
    expect(csv).not.toContain('null');
  });

  const SHIFT: WorkShift = {
    id: 's1',
    name: 'Pagi',
    locationId: 'loc-1',
    startTime: '07:00',
    endTime: '15:00',
    breakMinutes: 60,
  };
  const CODES = new Map([['loc-1', 'GDG']]);

  /**
   * This block replaces a test that asserted the OPPOSITE — that the shift
   * export deliberately carried no `location` column, because `ShiftDto` did
   * not report a shift's location and any value would have been a guess. That
   * was right at the time. `ShiftDto` gained `locationId` on 2026-08-27, so the
   * guess is gone and the column is now real; these cases pin the distinction
   * that made it worth adding.
   */
  it("mirrors the importer's `work_shifts` columns, in order", () => {
    expect(workShiftIoColumns(CODES).map((c) => c.header)).toEqual([
      'name',
      'location',
      'start_time',
      'end_time',
      'break_minutes',
    ]);
  });

  it('writes the location CODE, which is what the importer resolves against', () => {
    const csv = toCsv([SHIFT], workShiftIoColumns(CODES));
    expect(csv).toContain('GDG');
    // Not the id, which would fail every row.
    expect(csv).not.toContain('loc-1');
  });

  it('exports a company-wide shift as BLANK, not as a missing value', () => {
    // The importer's own hint: "kosongkan agar shift berlaku di SEMUA lokasi".
    // Blank is the meaningful value here, and this is the whole reason
    // `locationId` had to reach the client before import could be offered.
    const csv = toCsv([{ ...SHIFT, locationId: null }], workShiftIoColumns(CODES));
    const row = csv.split('\r\n')[1];
    expect(row).toBe('Pagi,,07:00,15:00,60');
  });

  it('exports blank for an id missing from the code map, which is why the panel gates on it', () => {
    // Blank means "every location" to the importer, so an incomplete map would
    // silently widen an outlet shift company-wide on re-import. RosterPanel
    // therefore only offers import once the map is non-empty — asserted here so
    // the hazard is recorded next to the behaviour that causes it.
    const csv = toCsv([SHIFT], workShiftIoColumns(new Map()));
    expect(csv.split('\r\n')[1]).toBe('Pagi,,07:00,15:00,60');
  });

  it('roster export adds one column per day, keyed by that date, blank when unassigned', () => {
    const days = [new Date('2026-08-24T00:00:00Z'), new Date('2026-08-25T00:00:00Z')];
    const row: RosterRow = {
      employeeId: 'e1',
      employeeName: 'Budi Santoso',
      days: [{ date: '2026-08-24', workShiftId: 's1', shiftName: 'Pagi' }],
    };
    const columns = rosterExportColumns(days);
    expect(columns.map((c) => c.header)).toEqual(['pegawai', '2026-08-24', '2026-08-25']);
    const csv = toCsv([row], columns);
    const [, line] = csv.split('\r\n');
    expect(line).toBe('Budi Santoso,Pagi,');
  });
});
