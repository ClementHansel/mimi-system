import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * mutating method reachable from `attendance.controller.ts`/
 * `employees.controller.ts`/`leaves.controller.ts`/`shifts.controller.ts`
 * (`checkIn`, `checkOut`, `correct`, `create`, `update`, `submit`, `approve`,
 * `reject`, `cancel`, `createShift`, `updateShift`, `upsertRoster`) ran its
 * writes directly on `req.dbClient` with no `COMMIT` anywhere in the
 * module — `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK`
 * therefore discarded every one of them silently. A Kasir clocking in via
 * `POST /api/hr/attendance/check-in` got a 201 with a full `AttendanceRow`
 * body, and the row was gone by the time payroll (M15, POUT-05 wage
 * deductions) or even a follow-up `GET /api/hr/attendance/me` looked for it.
 * Fixed by wrapping every mutating method's body in `withWrite`, matching
 * `waste-return`/`delivery`/`asset`/`item`/`location`/`product`/
 * `purchasing`/`stock-opname`'s existing convention exactly — never a
 * second pattern.
 *
 * `AttendanceService.applyCheckIn`/`applyCheckOut` and
 * `LeavesService.insertAndSubmit`/`applyCancel` are deliberately NOT
 * wrapped themselves: they are shared cores also called directly by
 * `AttendanceSyncProjector`/`LeaveSyncProjector` from INSIDE an
 * already-open ingest transaction (`SyncProjectorRegistry.project` runs
 * them under a `SAVEPOINT`, not a fresh `BEGIN`) — wrapping them in their
 * own `withWrite` would prematurely `COMMIT` that transaction out from
 * under the ingest pipeline. Only the REST-facing outer methods
 * (`checkIn`/`checkOut`/`submit`/`cancel`) call `withWrite`.
 */
export async function withWrite<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
