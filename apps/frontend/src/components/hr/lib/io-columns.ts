/**
 * Export (and, for `employees`, round-trip import) columns for F08 `hr`'s
 * six tabs.
 *
 * `EMPLOYEE_IO_COLUMNS` mirrors the bulk importer's `employees` entity
 * header-for-header (`apps/backend/src/modules/import/import-schema.ts`),
 * same convention as `components/purchasing/lib/io-columns.ts`: the
 * realistic bulk edit is "export what exists, fix it in a spreadsheet,
 * import it back", and that only works if an exported file is a valid
 * import file. `io-columns.test.ts` pins the header list against the same
 * literals since the coupling crosses a package boundary the compiler
 * cannot see.
 *
 * EVERYTHING ELSE HERE IS A REPORT, NOT A ROUND-TRIP FILE (same reasoning as
 * `components/outlet/lib/outlet-export-columns.ts`):
 *  - `attendance`/`leaves` have no importer counterpart at all — bulk-writing
 *    either would skip the geofence/selfie anti-fraud check (D-11/FR-HR-03)
 *    or the approval workflow (F-HR-06), so these columns are Indonesian
 *    report labels, never the importer's English column names.
 *  - `work_shifts` round-trips, but only since 2026-08-27. It was flagged
 *    BLOCKED first, and the reason is worth keeping: `ShiftDto`/`WorkShift`
 *    never put a shift's `location_id` on the wire — the list endpoint only
 *    ever FILTERED by it (`WHERE location_id = $1 OR location_id IS NULL`) —
 *    so a shift scoped to one outlet and a shift available everywhere were
 *    indistinguishable once they reached the client. Since the importer's
 *    natural key is (name, location), exporting a `location` column would
 *    have meant guessing, and guessing wrong strands a global shift on one
 *    outlet or leaks an outlet-only shift everywhere, silently, because the
 *    importer cannot know the guess was wrong. Rather than work around that,
 *    `ShiftDto` gained `locationId: UUID | null` and `WORK_SHIFT_IO_COLUMNS`
 *    below now reports the real value.
 *  - `roster` (shift ASSIGNMENTS, not shift templates) isn't an import-schema
 *    entity at all — the roster's own PUT is the only write path, and stays
 *    that way.
 *  - the four statutory-rate tables (BPJS/TER/PTKP/Article-17) aren't
 *    import-schema entities either; `payroll.statutory.config` (`hr-api.ts`'s
 *    dedicated PUT endpoints, gated behind `EffectiveWindowEditor`'s
 *    same-day/backdate guard) is the only intended write path for
 *    regulatory rate vintages.
 *  - `payroll` periods/runs/payslips are system-derived from attendance +
 *    statutory config, never hand-typed, so they are report-only too.
 *
 * Money and Qty stay VERBATIM decimal strings (CONTRACTS §0) everywhere
 * below — this is the one surface in the app where a re-derived or
 * float-rounded figure (a payslip's `net`, an employee's `base_salary`) is
 * least tolerable. Timestamps go through `fmtDate`/`fmtDateTime` so they read
 * in WITA (D-11) rather than shifting a late-evening check-out to the next
 * calendar day.
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate, fmtDateTime, toDateInput } from '@/lib/dates';
import type {
  Article17BracketRow,
  AttendanceRow,
  BpjsRow,
  Employee,
  Leave,
  Payslip,
  PayrollPeriod,
  PtkpRow,
  RosterRow,
  TerBracketRow,
  WorkShift,
} from './types';

/** An employee row enriched with the one importer column the list endpoint doesn't carry — see `employeeIoColumns` below. */
export interface EmployeeExportRow extends Employee {
  baseSalary: string;
}

/**
 * `employees` — `employee_number,name,position,location,join_date,
 * base_salary,nik,phone,email`.
 *
 * A FACTORY, not a plain array, because the importer's `location` column is
 * a location CODE and `Employee` only ever carries `locationId`/
 * `locationName` on the wire (`employees.service.ts`'s `mapEmployee`) — the
 * caller resolves codes once (a single `/locations` fetch) and hands in the
 * lookup, rather than this module re-fetching per column. An id absent from
 * the map (a location deactivated after the employee was hired, say) exports
 * a blank cell — a visible "unrecognized column value" in the import preview
 * beats silently mis-filing the employee under the wrong location code.
 */
export function employeeIoColumns(
  locationCodeById: Map<string, string>,
): CsvColumn<EmployeeExportRow>[] {
  return [
    { key: 'employeeNumber', header: 'employee_number' },
    { key: 'name', header: 'name' },
    { key: 'position', header: 'position' },
    {
      key: 'locationId',
      header: 'location',
      format: (r) => locationCodeById.get(r.locationId) ?? '',
    },
    { key: 'joinDate', header: 'join_date' },
    { key: 'baseSalary', header: 'base_salary' },
    { key: 'nik', header: 'nik', format: (r) => r.nik ?? '' },
    { key: 'phone', header: 'phone', format: (r) => r.phone ?? '' },
    { key: 'email', header: 'email', format: (r) => r.email ?? '' },
  ];
}

/**
 * `work_shifts` — `name,location,start_time,end_time,break_minutes`, mirroring
 * the importer header-for-header so an export re-imports.
 *
 * `locationCodes` maps location id -> `locations.code`, because the importer
 * resolves the `location` column against the CODE, not an id or a name. A
 * BLANK cell is meaningful and not a missing value: the importer's own hint
 * says "kosongkan agar shift berlaku di SEMUA lokasi", so `locationId: null`
 * must export as empty — that is precisely the distinction this column was
 * added to carry.
 *
 * A location id absent from the map also exports blank, which would silently
 * widen an outlet shift to every location on re-import. That is why the panel
 * fetches the map BEFORE offering the import button rather than lazily: an
 * incomplete map must not become a quiet rescoping.
 */
export function workShiftIoColumns(locationCodes: Map<string, string>): CsvColumn<WorkShift>[] {
  return [
    { key: 'name', header: 'name' },
    {
      key: 'locationId',
      header: 'location',
      format: (r) => (r.locationId ? (locationCodes.get(r.locationId) ?? '') : ''),
    },
    { key: 'startTime', header: 'start_time' },
    { key: 'endTime', header: 'end_time' },
    { key: 'breakMinutes', header: 'break_minutes' },
  ];
}

/**
 * `Jadwal Shift` tab, the ROSTER grid itself — one row per employee, one
 * column per day of the on-screen week, exactly like the table (D-style
 * "flatten to what's on screen", `outlet-export-columns.ts`'s convention).
 * A day with no assignment exports blank, not "Libur" — the two read
 * differently on the screen too (an empty cell vs. a chosen day-off value)
 * and collapsing them would lose that distinction.
 */
export function rosterExportColumns(days: Date[]): CsvColumn<RosterRow>[] {
  return [
    { key: 'employeeName', header: 'pegawai' },
    ...days.map((d) => {
      const dateStr = toDateInput(d);
      return {
        key: 'days' as const,
        header: dateStr,
        format: (r: RosterRow) => r.days.find((day) => day.date === dateStr)?.shiftName ?? '',
      };
    }),
  ];
}

/** `Absensi` tab — no importer counterpart (see file header: bypasses geofence/selfie). */
export const ATTENDANCE_EXPORT_COLUMNS: CsvColumn<AttendanceRow>[] = [
  { key: 'employeeName', header: 'pegawai' },
  { key: 'locationName', header: 'lokasi' },
  { key: 'date', header: 'tanggal', format: (r) => fmtDate(r.date) },
  {
    key: 'checkInAt',
    header: 'jam_masuk',
    format: (r) => (r.checkInAt ? fmtDateTime(r.checkInAt) : ''),
  },
  {
    key: 'checkOutAt',
    header: 'jam_pulang',
    format: (r) => (r.checkOutAt ? fmtDateTime(r.checkOutAt) : ''),
  },
  { key: 'lateMinutes', header: 'terlambat_menit' },
  { key: 'overtimeMinutes', header: 'lembur_menit' },
  { key: 'geofenceOk', header: 'dalam_radius', format: (r) => (r.geofenceOk ? 'ya' : 'tidak') },
  { key: 'status', header: 'status' },
  { key: 'timeSuspect', header: 'jam_diragukan', format: (r) => (r.timeSuspect ? 'ya' : 'tidak') },
];

/** `Cuti/Izin` tab — no importer counterpart (see file header: bypasses the approval workflow). */
export const LEAVE_EXPORT_COLUMNS: CsvColumn<Leave>[] = [
  { key: 'employeeName', header: 'pegawai' },
  { key: 'type', header: 'jenis' },
  { key: 'startDate', header: 'tanggal_mulai', format: (r) => fmtDate(r.startDate) },
  { key: 'endDate', header: 'tanggal_selesai', format: (r) => fmtDate(r.endDate) },
  // `days` is a decimal STRING (half-day leave is real) — exported verbatim.
  { key: 'days', header: 'jumlah_hari' },
  { key: 'reason', header: 'alasan', format: (r) => r.reason ?? '' },
  { key: 'status', header: 'status' },
  { key: 'decidedBy', header: 'diputuskan_oleh', format: (r) => r.decidedBy ?? '' },
];

/** `Payroll` tab — periods list. System-derived, no importer counterpart. */
export const PAYROLL_PERIOD_EXPORT_COLUMNS: CsvColumn<PayrollPeriod>[] = [
  { key: 'periodCode', header: 'periode' },
  { key: 'startDate', header: 'tanggal_mulai', format: (r) => fmtDate(r.startDate) },
  { key: 'endDate', header: 'tanggal_selesai', format: (r) => fmtDate(r.endDate) },
  { key: 'status', header: 'status' },
  { key: 'runs', header: 'jumlah_proses', format: (r) => r.runs.length },
];

/**
 * `Payroll` tab — one selected run's payslip lines. Money stays a verbatim
 * decimal string (CONTRACTS §0): this is payroll, the one place in the app a
 * re-derived or rounded figure is least acceptable, so `gross`/`deductions`/
 * `net`/`employerCost` are read straight off the wire, never recomputed here.
 */
export const PAYSLIP_EXPORT_COLUMNS: CsvColumn<Payslip>[] = [
  { key: 'employee', header: 'pegawai', format: (r) => r.employee.name },
  { key: 'employee', header: 'jabatan', format: (r) => r.employee.position },
  { key: 'employee', header: 'lokasi', format: (r) => r.employee.locationName },
  { key: 'gross', header: 'bruto' },
  { key: 'deductions', header: 'potongan' },
  { key: 'net', header: 'bersih' },
  { key: 'employerCost', header: 'beban_perusahaan' },
];

/** `Tarif Statutori` tab — BPJS vintages. Not an import-schema entity; the effective-window PUT is the only intended write path. */
export const BPJS_EXPORT_COLUMNS: CsvColumn<BpjsRow>[] = [
  { key: 'program', header: 'program' },
  { key: 'employerPct', header: 'persen_perusahaan' },
  { key: 'employeePct', header: 'persen_pegawai' },
  { key: 'salaryFloor', header: 'batas_bawah_gaji', format: (r) => r.salaryFloor ?? '' },
  { key: 'salaryCap', header: 'batas_atas_gaji', format: (r) => r.salaryCap ?? '' },
  { key: 'effectiveFrom', header: 'berlaku_sejak', format: (r) => fmtDate(r.effectiveFrom) },
  {
    key: 'effectiveTo',
    header: 'berlaku_sampai',
    format: (r) => (r.effectiveTo ? fmtDate(r.effectiveTo) : ''),
  },
];

/** `Tarif Statutori` tab — PPh21 TER brackets. */
export const TER_EXPORT_COLUMNS: CsvColumn<TerBracketRow>[] = [
  { key: 'category', header: 'kategori' },
  { key: 'bracketMin', header: 'batas_bawah' },
  { key: 'bracketMax', header: 'batas_atas', format: (r) => r.bracketMax ?? '' },
  { key: 'ratePct', header: 'tarif_persen' },
  { key: 'effectiveFrom', header: 'berlaku_sejak', format: (r) => fmtDate(r.effectiveFrom) },
  {
    key: 'effectiveTo',
    header: 'berlaku_sampai',
    format: (r) => (r.effectiveTo ? fmtDate(r.effectiveTo) : ''),
  },
];

/** `Tarif Statutori` tab — PTKP table. */
export const PTKP_EXPORT_COLUMNS: CsvColumn<PtkpRow>[] = [
  { key: 'ptkpCode', header: 'kode_ptkp' },
  { key: 'annualAmount', header: 'jumlah_tahunan' },
  { key: 'terCategory', header: 'kategori_ter' },
  { key: 'effectiveFrom', header: 'berlaku_sejak', format: (r) => fmtDate(r.effectiveFrom) },
  {
    key: 'effectiveTo',
    header: 'berlaku_sampai',
    format: (r) => (r.effectiveTo ? fmtDate(r.effectiveTo) : ''),
  },
];

/** `Tarif Statutori` tab — Article-17 progressive brackets. */
export const ARTICLE17_EXPORT_COLUMNS: CsvColumn<Article17BracketRow>[] = [
  { key: 'bracketMin', header: 'batas_bawah' },
  { key: 'bracketMax', header: 'batas_atas', format: (r) => r.bracketMax ?? '' },
  { key: 'ratePct', header: 'tarif_persen' },
  { key: 'effectiveFrom', header: 'berlaku_sejak', format: (r) => fmtDate(r.effectiveFrom) },
  {
    key: 'effectiveTo',
    header: 'berlaku_sampai',
    format: (r) => (r.effectiveTo ? fmtDate(r.effectiveTo) : ''),
  },
];
