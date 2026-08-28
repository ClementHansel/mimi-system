/**
 * System-level RLS context for `ColdChainService.resolveBreachRecipients`
 * (D-21/D-22). `DATABASE_POOL` connects as `mimi_app` — non-superuser,
 * `NOINHERIT` into `app_user` (migrations 203/205) — so a bare query on a
 * fresh connection has NO table privileges at all until `SET LOCAL ROLE
 * app_user` runs, and even then `users`/`roles`/`user_locations`'s SELECT
 * policy (migration 009) is `ROLE(owner,manager,hr_admin,finance) OR self` —
 * the acting user on a real request is usually a driver or Kepala Gudang
 * (the ones who actually log temperatures), who would see only their OWN row
 * under their own session's RLS context. Resolving "who do we notify on a
 * cold-chain breach" is a cross-cutting, system-level lookup independent of
 * the acting user's own visibility.
 *
 * D-02 (2026-08-28) — this used to carry its OWN copy of the transaction +
 * `set_config` logic, on the reasoning that `modules/delivery` should not
 * import another module's internals (BUILD-PLAN §6 rule 1). That rule stands,
 * and this now satisfies it a better way: it delegates to
 * `common/database/system-context.ts`, which is shared infrastructure rather
 * than another module's private detail — the canonical home the rule points
 * at, not around.
 *
 * The copy had already diverged, which is why it was worth retiring rather
 * than tolerating. It set `app.role` and `app.location_ids` but **never set
 * `app.user_id`**, unlike every other implementation. Nothing this file
 * guards keys off identity today, so no behaviour was observably wrong — but
 * `modules/inventory/low-stock`'s equivalent explicitly sets a sentinel to
 * avoid "depending on connection-reuse history", and this one silently did
 * not. A second copy of the function that establishes the RLS context is a
 * bad place for that kind of drift: a divergence there is a silent
 * authorization difference, not a wrong number.
 */
import type { Pool, PoolClient } from 'pg';
import {
  SYSTEM_CENTRAL_ROLE,
  withSystemContext as withCanonicalSystemContext,
} from '../../common/database/system-context';

/**
 * Runs `fn` inside a fresh transaction with the central-role RLS bypass
 * asserted, committing on success.
 *
 * Signature is unchanged from the local implementation this replaced, so
 * every call site reads the same; only the body moved.
 */
export async function withSystemContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCanonicalSystemContext(pool, { role: SYSTEM_CENTRAL_ROLE }, fn);
}
