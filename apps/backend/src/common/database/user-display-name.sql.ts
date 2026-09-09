/**
 * The display name of the PERSON behind a row that stores its own copy of one.
 *
 * ── The bug this exists to kill ──────────────────────────────────────────────
 *
 * `drivers.name` is a duplicate of a human's name, and it drifted. On production
 * (2026-09-09) the two active drivers read:
 *
 *   login    delivery screens (drivers.name)   users/employees say
 *   driver1  Dian Santoso                      Ayu Rahayu   (#EMP0090)
 *   driver2  Yanto Hidayat                     Bagus Rahayu (#EMP0091)
 *
 * `seed.ts` inserted one name, `org-model.ts` later renamed the person, and its
 * own INSERT is guarded on `NOT EXISTS` so the `drivers` row was never updated.
 * The client then read "Dian Santoso" off the dispatcher screen, searched the
 * user list for it, found nothing, and reported two drivers as MISSING — they
 * were present the whole time under a different name. It also printed the wrong
 * name on the Surat Jalan (functional test 2026-09-07, finding #10). Re-asserting
 * the name in the seed was the first fix, and it only helps a box that gets
 * re-seeded; production never does.
 *
 * ── Why a SQL fragment and not a JOIN ───────────────────────────────────────
 *
 * `users_select` (migration 009) is `app_is_central() OR app_is_self(id)`, so a
 * plain `LEFT JOIN users` yields NULL for exactly the roles that live on these
 * screens — KEPALA GUDANG and DRIVER are neither central nor themselves — and a
 * NULL would silently fall back to the stale copy, fixing nothing where it
 * matters. `app_user_display()` (migration 212) is the SECURITY DEFINER lookup
 * built for this: it returns only `(id, name, role_key)`, works for any caller,
 * and never widens `users_select` itself.
 *
 * ── Why COALESCE and not a replacement ─────────────────────────────────────
 *
 * A driver need not be a system user: `drivers.user_id` is nullable, and a
 * casual or third-party driver legitimately has a name and no login. For those
 * rows the stored copy IS the only name there is, so it stays as the fallback.
 * The precedence is what matters — the account is the truth when there is one.
 *
 * @param alias SQL alias of the table holding `user_id` and `name`. A
 *   code-controlled identifier only — every call site passes a literal, exactly
 *   as `DOCUMENT_NUMBER_SOURCE` in `kernel/approvals` does. NEVER pass user
 *   input here.
 */
export function userDisplayNameSql(alias: string): string {
  return `COALESCE((SELECT ud.name FROM app_user_display(ARRAY[${alias}.user_id]) ud), ${alias}.name)`;
}
