import type { Pool } from 'pg';
import type { RoleKey } from '@mimi/shared';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';

/**
 * B-07 — resolving WHO to notify for a pending approval step (or, symmetrically,
 * "who just decided a step and needs the next one told") is a cross-user,
 * cross-location read: the caller in whose transaction `ApprovalService.submit()`/
 * `decide()` is running is essentially never one of the people who need to
 * be told about the step that just opened up (a Kasir submitting a void
 * notifies a Supervisor; a Supervisor deciding step 1 notifies a Kepala
 * Gudang for step 2). Cannot run on the caller's own `DbClient` for the
 * identical reason `NotificationService.resolveContacts()`
 * (`kernel/notification/notification.service.ts`) and
 * `ColdChainService.resolveBreachRecipients()` (`modules/delivery`) both
 * document: `users_select`'s RLS (migration 009) is `ROLE(owner,manager,
 * hr_admin,finance) OR self`, which drops every OTHER user's row entirely
 * under a scoped caller's own session — not a narrower result, an EMPTY one.
 *
 * Uses `common/database/system-context.ts`'s `withSystemContext` — the
 * canonical helper (this ticket's brief: "do not widen a caller's own RLS
 * context, and do not reach for a raw pool") — never a bare `pool.query()`
 * (`mimi_app` holds zero direct table grants, migrations 203/205) and never
 * the caller's own already-scoped connection.
 *
 * Role-keys in `CENTRAL_ROLES` (owner/manager/finance/hr_admin — the same
 * four `common/scope/scope.service.ts`, and every other module's own
 * duplicate of this exact set, special-case; CONTRACTS §1.14) are notified
 * regardless of `locationId` — they already see every location. Every other
 * (location-scoped) eligible role is filtered to users actually assigned to
 * `locationId` via `user_locations`. A `null` `locationId` (a document type
 * with no location scope at all, e.g. `payroll_run`, `leave_request`) leaves
 * a scoped role UNFILTERED rather than notifying nobody — there is no
 * location to filter BY, which is not the same thing as "filter to zero".
 */
const CENTRAL_ROLES = ['owner', 'manager', 'finance', 'hr_admin'];

export async function resolveApproverUserIds(
  pool: Pool,
  roles: readonly RoleKey[],
  locationId: string | null,
): Promise<string[]> {
  if (roles.length === 0) return [];
  return withSystemContext(pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN user_locations ul ON ul.user_id = u.id
        WHERE u.is_active
          AND r.key = ANY($1::text[])
          AND (
            r.key = ANY($2::text[])
            OR $3::uuid IS NULL
            OR ul.location_id = $3
          )`,
      [roles, CENTRAL_ROLES, locationId],
    );
    return res.rows.map((row) => row.id);
  });
}
