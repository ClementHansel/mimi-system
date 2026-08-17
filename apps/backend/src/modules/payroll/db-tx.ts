import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * mutating method across `payroll`'s five sub-services (`components`,
 * `loans`, `periods`, `runs`, `statutory` — 37 raw `INSERT INTO`/
 * `UPDATE ... SET` writes total) ran directly on `req.dbClient` with no
 * `COMMIT` anywhere in the module — `RlsCleanupInterceptor`'s unconditional
 * post-request `ROLLBACK` therefore discarded every one of them silently.
 * `POST /api/payroll/runs/:id/approve` (and every other mutating payroll
 * endpoint) returned 201/200 with a full body; a follow-up `GET` on that
 * run/loan/period/component/statutory-config 404'd or showed the pre-write
 * state. Especially dangerous here: `runs.service.ts`'s `approve` posts real
 * money (loan installments, payment_verifications) that would have silently
 * vanished — a payroll run could report success while paying nobody. Fixed
 * by wrapping every mutating method's body in `withWrite`, matching
 * `stock-opname`/`waste-return`/`delivery`/`asset`/`item`/`location`/
 * `product`/`purchasing`'s existing convention exactly — never a second
 * pattern. `periods.service.ts`'s internal `markStatus` helper is called
 * ONLY from within an already-`withWrite`-wrapped caller (`runs.service.ts`),
 * so it is not separately wrapped — a nested `BEGIN` on an already-open
 * transaction is a harmless no-op, matching `stock-opname.service.ts`'s
 * `postAdjustments` (never independently wrapped, always called from inside
 * another method's `withWrite`).
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
