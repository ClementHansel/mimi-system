/**
 * Typed REST calls for F11 `me` (CONTRACTS.md §4.14 `hr` / §4.15 `payroll`'s
 * own-scoped endpoints: `/hr/attendance/me`, `/hr/leaves/me|POST /hr/leaves`,
 * `/payroll/my-slips`).
 *
 * Check-in/check-out are DELIBERATELY NOT here — coordinator review (see
 * `AbsenPanel.offline.test.ts`) corrected an earlier version of this file
 * that called `POST /hr/attendance/check-in|out` directly: `LocalRuntime`
 * already has `commitAttendanceCheckIn`/`commitAttendanceCheckOut`
 * (`local-runtime.ts:211,215`), backed cloud-side by W3-09's
 * `AttendanceSyncProjector` (`defensibleAt` clamp + `time_suspect` tagging)
 * built for exactly this path. Routing check-in/out through the plain REST
 * client made a connectivity problem into a wage loss (POUT-03 marks a
 * failed check-in as *alpha*, which is a deduction) for the lowest-paid,
 * worst-connectivity users in the system — see `components/me/AbsenPanel.tsx`
 * and `components/me/lib/me-runtime.ts` for the corrected local-commit path.
 *
 * `createLeaveRequest`/`cancelLeaveRequest` below remain plain REST calls —
 * `LocalRuntime` has no `SyncEntity` mapping for `leave_requests` either, but
 * unlike attendance this wasn't flagged as needing remediation in this pass
 * (no wage-loss mechanism turns a delayed leave request into lost pay the
 * way POUT-03 does for attendance); noted here rather than silently copied
 * as "fine" — a candidate for the same B-11-style follow-up if it turns out
 * to matter.
 *
 * Strict self-scoping: every path here is the `.me`/`self`-suffixed
 * endpoint from CONTRACTS §4.14/4.15 — never the admin list endpoint with a
 * client-supplied `employeeId` filter. The backend enforces this
 * server-side regardless; this module just never gives the UI a way to even
 * try asking for someone else's record.
 */
import { api } from '@/lib/api';
import type { AttendanceRow, MyLeaves, Leave } from '@/components/hr/lib/types';
import type { Payslip } from '@/components/hr/lib/types';
import type { LocationGeo } from '@/components/hr/lib/types';

export function getMyAttendance(month: string) {
  return api.get<AttendanceRow[]>(`/hr/attendance/me?month=${month}`);
}

const DEFAULT_QUOTA: MyLeaves['quota'] = {
  annual: { total: 12, used: 0 },
  marriage: { total: 3, used: 0 },
};

/**
 * CONTRACTS §4.14 documents this response shape unusually as
 * `Leave[] & quota: {...}` — a plain JSON array cannot actually carry an
 * extra named property over the wire (JSON.stringify drops non-index
 * properties on arrays), so this defensively accepts either a plain array
 * (falls back to a zeroed quota display, flagged to the user as "belum
 * tersedia" via `quotaUnavailable`) or `{ leaves, quota }` — whichever the
 * backend actually sends. Reported as an endpoint-shape mismatch (see W4-10
 * report) rather than guessed at silently.
 */
export function getMyLeaves(year: string): Promise<MyLeaves & { quotaUnavailable: boolean }> {
  return api.get<unknown>(`/hr/leaves/me?year=${year}`).then((res) => {
    if (Array.isArray(res)) {
      return { leaves: res as Leave[], quota: DEFAULT_QUOTA, quotaUnavailable: true };
    }
    const obj = res as { leaves?: Leave[]; rows?: Leave[]; quota?: MyLeaves['quota'] };
    return {
      leaves: obj.leaves ?? obj.rows ?? [],
      quota: obj.quota ?? DEFAULT_QUOTA,
      quotaUnavailable: !obj.quota,
    };
  });
}

export function createLeaveRequest(body: {
  clientId: string;
  type: string;
  startDate: string;
  endDate: string;
  reason?: string;
  attachmentId?: string;
}) {
  return api.post<Leave>('/hr/leaves', body);
}

export function cancelLeaveRequest(id: string) {
  return api.post<Leave>(`/hr/leaves/${id}/cancel`);
}

export function getMySlips(year: string) {
  return api.get<Payslip[]>(`/payroll/my-slips?year=${year}`);
}

export function getLocationGeo(id: string) {
  return api.get<LocationGeo>(`/locations/${id}`);
}
