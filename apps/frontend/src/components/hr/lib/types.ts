/**
 * Wire shapes for F08 `hr` (CONTRACTS.md §4.14 `hr` + §4.15 `payroll`) and F11
 * `me`'s own-scoped slice of the same modules. Transcribed verbatim from
 * CONTRACTS, kept local to `components/hr` (not `lib/shared-types`, which is
 * W1-E's frozen seam) — same idiom as `components/outlet/lib/types.ts`.
 */
import type { Money, Qty, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

// ── §4.14 hr ─────────────────────────────────────────────────────────────────

export interface Employee {
  id: UUID;
  employeeNumber: string;
  userId: UUID | null;
  name: string;
  position: string;
  locationId: UUID;
  locationName: string;
  employmentStatus: string;
  joinDate: ISODate;
  phone: string | null;
  nik?: string | null;
  email?: string | null;
}

export interface EmploymentHistoryEntry {
  position: string;
  locationName: string;
  baseSalary?: Money;
  startDate: ISODate;
  endDate: ISODate | null;
}

export interface EmployeeDetail extends Employee {
  employments: EmploymentHistoryEntry[];
}

export interface AttendanceRow {
  id: UUID;
  employeeId: UUID;
  employeeName: string;
  locationName: string;
  date: ISODate;
  status: string;
  checkInAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  lateMinutes: number;
  overtimeMinutes: number;
  geofenceOk: boolean;
  selfieUrls: { in: string | null; out: string | null };
  timeSuspect: boolean;
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

export interface WorkShift {
  id: UUID;
  name: string;
  /**
   * The outlet this shift belongs to, or `null` for a company-wide shift.
   * Added to `ShiftDto` on 2026-08-27 — until then the list endpoint only
   * FILTERED by location and never reported it, which is what blocked bulk
   * import: the importer's natural key is (name, location).
   */
  locationId: UUID | null;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

export interface RosterDay {
  date: ISODate;
  workShiftId: UUID | null;
  shiftName: string | null;
}

export interface RosterRow {
  employeeId: UUID;
  employeeName: string;
  days: RosterDay[];
}

export interface Leave {
  id: UUID;
  employeeName: string;
  type: string;
  startDate: ISODate;
  endDate: ISODate;
  days: string;
  reason: string | null;
  status: string;
  attachmentUrl: string | null;
  decidedBy: string | null;
}

export interface LeaveQuota {
  annual: { total: 12; used: number };
  marriage: { total: 3; used: number };
}

export interface MyLeaves {
  leaves: Leave[];
  quota: LeaveQuota;
}

/**
 * Employment contract (W7 + the 2026-08-27 CRUD/import/export/signature
 * follow-up, migration 230 + 252). `signedAt` here is the LEGACY single date
 * on the row (when the physical document was dated) — NOT the same thing as
 * `employeeSigned`/`companySignerCount`/`fullySigned`, which come from the
 * per-party `contract_signatures` table and are what actually gates
 * `status: 'active'` at the database (see `ContractsPanel`'s doc comment).
 */
export interface Contract {
  id: UUID;
  contractNumber: string;
  employeeId: UUID;
  employeeName: string;
  employeeNumber: string;
  contractType: 'pkwt' | 'pkwtt' | 'probation' | 'internship';
  position: string;
  locationId: UUID | null;
  locationName: string | null;
  baseSalary: Money | null;
  startDate: ISODate;
  endDate: ISODate | null;
  status: 'draft' | 'active' | 'expired' | 'terminated';
  signedAt: ISODate | null;
  documentAttachmentId: UUID | null;
  terminationReason: string | null;
  notes: string | null;
  daysUntilExpiry: number | null;
  employeeSigned: boolean;
  companySignerCount: number;
  fullySigned: boolean;
}

export interface ContractSignature {
  id: UUID;
  contractId: UUID;
  partyType: 'employee' | 'company';
  employeeId: UUID | null;
  userId: UUID | null;
  signerName: string;
  signedAt: ISODateTime;
  method: 'wet_ink_scan' | 'digital' | 'in_person_witnessed';
  notes: string | null;
}

// ── §4.15 payroll ────────────────────────────────────────────────────────────

export interface ApprovalDetailRef {
  approvalId: UUID;
  state: string;
  amount: Money | null;
  steps: {
    stepNo: number;
    approverRole: string;
    state: 'pending' | 'approved' | 'rejected' | 'skipped';
    actedBy: string | null;
    actedAt: ISODateTime | null;
    reason: string | null;
    offlineAuthorized: boolean;
    reverificationStatus: 'verified' | 'failed' | 'unprovable' | null;
  }[];
}

export interface PayrollRun {
  id: UUID;
  runNumber: string;
  periodCode: string;
  status: string;
  statutoryMode: boolean;
  employeeCount: number;
  totalGross: Money;
  totalDeductions: Money;
  totalNet: Money;
  totalEmployerCost: Money;
  calculatedAt: ISODateTime | null;
  approval: ApprovalDetailRef | null;
  paidAt: ISODateTime | null;
}

export interface PayrollPeriod {
  id: UUID;
  periodCode: string;
  startDate: ISODate;
  endDate: ISODate;
  status: string;
  runs: { id: UUID; runNumber: string; status: string }[];
}

export interface PayslipLine {
  componentCode: string;
  componentName: string;
  type: 'earning' | 'deduction' | 'employer_cost';
  isStatutory: boolean;
  qty: Qty | null;
  rate: Money | null;
  amount: Money;
  sourceRefType: string | null;
  manualOverride: boolean;
}

export interface Payslip {
  runId: UUID;
  periodCode: string;
  employee: { id: UUID; name: string; position: string; locationName: string };
  lines: PayslipLine[];
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
  slipPdfUrl: string | null;
}

export interface PayrollRunDetail extends PayrollRun {
  employees: Payslip[];
}

export interface PayrollComponent {
  id: UUID;
  code: string;
  name: string;
  /**
   * `'employer_cost'` (BPJS employer shares, Amendment 1) is a real value
   * `GET /payroll/components` returns — it is one of the 16+ seeded
   * `is_system` rows — but `CreateComponentDto` only ever accepts
   * `'earning'|'deduction'`, so it can never be the value a CREATE form
   * submits. Widened here (past the narrower `'earning'|'deduction'` this
   * interface used to declare) so the master list can display every row the
   * server actually returns; `SalaryComponentsPanel`'s create form still only
   * offers the two creatable values.
   */
  type: 'earning' | 'deduction' | 'employer_cost';
  calcMethod: string;
  formulaKey: string | null;
  defaultAmount: Money | null;
  isSystem: boolean;
  /**
   * `salary_components.is_active` — the sanctioned way to retire a component
   * created by mistake (the table has no delete, and a component referenced
   * by a past payroll run must never be hard-deletable). `UpdateComponentDto`
   * has always accepted this field on write; it reached the wire on read only
   * as of the components.service.ts `mapComponent` fix that added it.
   */
  isActive: boolean;
}

/** One row of a component's per-employee assignment history (`GET`/`PUT /payroll/employees/:employeeId/components`, §4.15 PIN-03..06). */
export interface EmployeeComponentAssignment extends EffectiveDatedRow {
  componentId: UUID;
  code: string;
  amount: Money | null;
}

export interface Loan {
  id: UUID;
  loanNumber: string;
  employeeName: string;
  principal: Money;
  monthlyInstallment: Money;
  outstanding: Money;
  status: string;
}

// ── Amendment 1 — statutory config (effective-dated) ────────────────────────

export interface EffectiveDatedRow {
  effectiveFrom: ISODate;
  effectiveTo: ISODate | null;
}

export interface BpjsRow extends EffectiveDatedRow {
  id: UUID;
  program: 'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp';
  employerPct: string;
  employeePct: string;
  salaryFloor: Money | null;
  salaryCap: Money | null;
}

export interface TerBracketRow extends EffectiveDatedRow {
  id: UUID;
  category: 'A' | 'B' | 'C';
  bracketMin: Money;
  bracketMax: Money | null;
  ratePct: string;
}

export interface PtkpRow extends EffectiveDatedRow {
  id: UUID;
  ptkpCode: string;
  annualAmount: Money;
  terCategory: 'A' | 'B' | 'C';
}

export interface Article17BracketRow extends EffectiveDatedRow {
  id: UUID;
  bracketMin: Money;
  bracketMax: Money | null;
  ratePct: string;
}

export interface TaxProfile {
  npwp: string | null;
  ptkpCode: string;
  dependantsCount: number;
  bpjsEnrollments: Partial<
    Record<
      'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp',
      { enrolledSince: ISODate; endedAt: ISODate | null }
    >
  >;
  bpjsSalaryBase: Money | null;
}

// ── §4.3 location — the geofence centre this surface reads (read-only here) ─

export interface LocationGeo {
  id: UUID;
  name: string;
  latitude: string | null;
  longitude: string | null;
  geofenceRadiusM: number;
}
