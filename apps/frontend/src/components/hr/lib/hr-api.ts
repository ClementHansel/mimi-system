/**
 * Typed REST calls for F08 `hr` (CONTRACTS.md §4.14 `hr` + §4.15 `payroll`).
 * Thin wrappers over `@/lib/api`'s `api` client — every path/shape here is
 * transcribed verbatim from CONTRACTS, nothing invented.
 *
 * NOTE on offline-first (same gap `components/outlet/lib/outlet-api.ts`
 * flags for F04, transcribed here because F11 `me`'s attendance check-in/out
 * is listed alongside F02/F04/F13 as an offline-first surface in
 * `lib/api.ts`'s module doc): `LocalRuntime` has no `SyncEntity`/op mapping
 * for `attendance` or `leave_requests` yet, so both this module and
 * `components/me/lib/me-api.ts` call the online client directly. This works
 * correctly against the live backend today (and — for HR's laptop-based
 * back-office screens here — matches how every other Wave-4 admin surface
 * already operates) but means a check-in attempted with zero connectivity in
 * the car park at 6am will fail rather than queue. Flagged for W2-E/architect
 * follow-up, not silently worked around, exactly as `outlet-api.ts` did for
 * F04's equivalent gap.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type {
  Employee, EmployeeDetail, AttendanceRow, AttendanceSummaryRow, WorkShift, RosterRow, Leave,
  PayrollPeriod, PayrollRunDetail, PayrollComponent, Loan, BpjsRow, TerBracketRow, PtkpRow,
  Article17BracketRow, TaxProfile, LocationGeo,
} from './types';

// ── employees (§4.14) ────────────────────────────────────────────────────────

export function listEmployees(params: { locationId?: string; status?: string; q?: string; page?: number }) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  return api.get<Paginated<Employee>>(`/hr/employees?${qs.toString()}`);
}

export function getEmployee(id: string) {
  return api.get<EmployeeDetail>(`/hr/employees/${id}`);
}

export function createEmployee(body: {
  employeeNumber: string; name: string; nik?: string; phone?: string; email?: string; joinDate: string;
  position: string; locationId: string; baseSalary: string;
  bankName?: string; bankAccountNumber?: string; bankAccountName?: string; userId?: string;
}) {
  return api.post<Employee>('/hr/employees', body);
}

export function updateEmployee(id: string, body: Partial<{
  name: string; nik: string; phone: string; email: string; position: string;
  employmentChange: { position: string; locationId: string; baseSalary: string; startDate: string };
}>) {
  return api.patch<Employee>(`/hr/employees/${id}`, body);
}

// ── attendance (§4.14) ───────────────────────────────────────────────────────

export function listAttendance(params: { locationId?: string; date?: string; employeeId?: string; status?: string; page?: number }) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.date) qs.set('date', params.date);
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  if (params.status) qs.set('status', params.status);
  return api.get<Paginated<AttendanceRow>>(`/hr/attendance?${qs.toString()}`);
}

export function correctAttendance(id: string, body: { status?: string; checkInAt?: string; checkOutAt?: string; correctionReason: string }) {
  return api.patch<AttendanceRow>(`/hr/attendance/${id}`, body);
}

export function getAttendanceSummary(params: { periodCode: string; locationId?: string; employeeId?: string }) {
  const qs = new URLSearchParams({ periodCode: params.periodCode });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return api.get<AttendanceSummaryRow[]>(`/hr/attendance/summary?${qs.toString()}`);
}

// ── shifts & roster (§4.14) ──────────────────────────────────────────────────

export function listShifts(locationId?: string) {
  const qs = new URLSearchParams();
  if (locationId) qs.set('locationId', locationId);
  return api.get<WorkShift[]>(`/hr/shifts?${qs.toString()}`);
}

export function createShift(body: { locationId?: string; name: string; startTime: string; endTime: string; breakMinutes?: number }) {
  return api.post<WorkShift>('/hr/shifts', body);
}

export function getRoster(params: { locationId: string; from: string; to: string; employeeId?: string }) {
  const qs = new URLSearchParams({ locationId: params.locationId, from: params.from, to: params.to });
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return api.get<RosterRow[]>(`/hr/roster?${qs.toString()}`);
}

export function putRoster(body: { locationId: string; assignments: { employeeId: string; date: string; workShiftId: string | null }[] }) {
  return api.put<RosterRow[]>('/hr/roster', body);
}

// ── leave (§4.14) ────────────────────────────────────────────────────────────

export function listLeaves(params: { locationId?: string; status?: string; type?: string; employeeId?: string; page?: number }) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return api.get<Paginated<Leave>>(`/hr/leaves?${qs.toString()}`);
}

export function approveLeave(id: string, note?: string) {
  return api.post<Leave>(`/hr/leaves/${id}/approve`, { note });
}

export function rejectLeave(id: string, reason: string) {
  return api.post<Leave>(`/hr/leaves/${id}/reject`, { reason });
}

// ── locations (§4.3) — read-only geofence centre for attendance review ─────

export function getLocationGeo(id: string) {
  return api.get<LocationGeo>(`/locations/${id}`);
}

// ── payroll periods & runs (§4.15) ──────────────────────────────────────────

export function listPayrollPeriods(page = 1) {
  return api.get<Paginated<PayrollPeriod>>(`/payroll/periods?page=${page}`);
}

export function createPayrollPeriod(periodCode: string) {
  return api.post<PayrollPeriod>('/payroll/periods', { periodCode });
}

export function calculatePayrollRun(periodId: string, employeeIds?: string[]) {
  return api.post<PayrollRunDetail>(`/payroll/periods/${periodId}/calculate`, employeeIds ? { employeeIds } : {});
}

export function getPayrollRun(id: string) {
  return api.get<PayrollRunDetail>(`/payroll/runs/${id}`);
}

export function overridePayrollLine(runId: string, lineId: string, amount: string, overrideReason: string) {
  return api.patch(`/payroll/runs/${runId}/lines/${lineId}`, { amount, overrideReason });
}

export function recalculatePayrollRun(runId: string) {
  return api.post<PayrollRunDetail>(`/payroll/runs/${runId}/recalculate`);
}

export function submitPayrollRun(runId: string) {
  return api.post<PayrollRunDetail>(`/payroll/runs/${runId}/submit`);
}

export function approvePayrollRun(runId: string, note?: string) {
  return api.post<PayrollRunDetail>(`/payroll/runs/${runId}/approve`, { note });
}

export function rejectPayrollRun(runId: string, reason: string) {
  return api.post<PayrollRunDetail>(`/payroll/runs/${runId}/reject`, { reason });
}

export function markPayrollRunPaid(runId: string, paymentVerificationId: string) {
  return api.post<PayrollRunDetail>(`/payroll/runs/${runId}/mark-paid`, { paymentVerificationId });
}

export function sendPayrollSlips(runId: string, channels: ('email' | 'whatsapp')[]) {
  return api.post<{ queued: number; skippedNoContact: number }>(`/payroll/runs/${runId}/send-slips`, { channels });
}

export function listPayrollComponents() {
  return api.get<PayrollComponent[]>('/payroll/components');
}

// ── loans (§4.15, POUT-06) ───────────────────────────────────────────────────

export function listLoans(params: { employeeId?: string; status?: string; page?: number }) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  if (params.status) qs.set('status', params.status);
  return api.get<Paginated<Loan>>(`/payroll/loans?${qs.toString()}`);
}

export function createLoan(body: { employeeId: string; principal: string; monthlyInstallment: string; reason?: string }) {
  return api.post<Loan>('/payroll/loans', body);
}

export function approveLoan(id: string, note?: string) {
  return api.post<Loan>(`/payroll/loans/${id}/approve`, { note });
}

export function rejectLoan(id: string, reason: string) {
  return api.post<Loan>(`/payroll/loans/${id}/reject`, { reason });
}

// ── statutory config (§4.15 Amendment 1) — the editors W4-05 declined ──────

export function getStatutoryBpjs(program?: string, asOf?: string) {
  const qs = new URLSearchParams();
  if (program) qs.set('program', program);
  if (asOf) qs.set('asOf', asOf);
  return api.get<BpjsRow[]>(`/payroll/statutory/bpjs?${qs.toString()}`);
}

export function putStatutoryBpjs(rows: { program: string; employerPct: string; employeePct: string; salaryFloor?: string; salaryCap?: string; effectiveFrom: string }[]) {
  return api.put<BpjsRow[]>('/payroll/statutory/bpjs', { rows });
}

export function getStatutoryTer(category?: string, asOf?: string) {
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (asOf) qs.set('asOf', asOf);
  return api.get<TerBracketRow[]>(`/payroll/statutory/pph21/ter?${qs.toString()}`);
}

export function putStatutoryTer(effectiveFrom: string, rows: { category: string; bracketMin: string; bracketMax?: string; ratePct: string }[]) {
  return api.put<TerBracketRow[]>('/payroll/statutory/pph21/ter', { effectiveFrom, rows });
}

export function getStatutoryPtkp(asOf?: string) {
  const qs = new URLSearchParams();
  if (asOf) qs.set('asOf', asOf);
  return api.get<PtkpRow[]>(`/payroll/statutory/pph21/ptkp?${qs.toString()}`);
}

export function putStatutoryPtkp(effectiveFrom: string, rows: { ptkpCode: string; annualAmount: string; terCategory: string }[]) {
  return api.put<PtkpRow[]>('/payroll/statutory/pph21/ptkp', { effectiveFrom, rows });
}

export function getStatutoryArticle17(asOf?: string) {
  const qs = new URLSearchParams();
  if (asOf) qs.set('asOf', asOf);
  return api.get<Article17BracketRow[]>(`/payroll/statutory/pph21/article17?${qs.toString()}`);
}

export function putStatutoryArticle17(effectiveFrom: string, rows: { bracketMin: string; bracketMax?: string; ratePct: string }[]) {
  return api.put<Article17BracketRow[]>('/payroll/statutory/pph21/article17', { effectiveFrom, rows });
}

export function getTaxProfile(employeeId: string) {
  return api.get<TaxProfile & { employeeId: string }>(`/payroll/employees/${employeeId}/tax-profile`);
}

export function putTaxProfile(employeeId: string, profile: TaxProfile) {
  return api.put<TaxProfile & { employeeId: string }>(`/payroll/employees/${employeeId}/tax-profile`, profile);
}
