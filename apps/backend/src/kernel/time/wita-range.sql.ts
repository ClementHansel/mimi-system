/**
 * SQL fragments for filtering a `timestamptz` column by WITA business date —
 * written so the filter can actually drive an index under RLS.
 *
 * ## Why this exists at all
 *
 * The obvious way to write it is the one that was written everywhere:
 *
 *     (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date BETWEEN $1 AND $2
 *
 * That is correct, readable, and — under row-level security — quietly forces a
 * sequential scan of the whole table no matter what index exists.
 *
 * Postgres will not push a qual below an RLS barrier unless every function in
 * it is marked LEAKPROOF, because a non-leakproof qual could reveal values
 * from rows the policy is supposed to hide (it could error, or leak through a
 * side channel, on data the caller may not see). `timezone()` — what
 * `AT TIME ZONE` compiles to — is not leakproof. So the whole expression is
 * demoted to a post-hoc Filter, applied only AFTER the policy has already
 * fetched every row, and no index on it can be used.
 *
 * On the dashboard's overview endpoint that was the difference between 1.55s
 * and 0.59s against a quarter of real trading (migration 245 has the full
 * write-up and the plans).
 *
 * **This is invisible to a superuser EXPLAIN.** With no RLS barrier there is no
 * restriction, the index gets used, and the plan looks fine — which is exactly
 * how it survived. Always measure these as `app_user` with the `app.*` GUCs set.
 *
 * ## The shape that works
 *
 * Keep the column bare and do the timezone arithmetic on the BIND PARAMETERS.
 * Those fold to constants at plan time, leaving two plain `timestamptz`
 * comparisons — leakproof, indexable, and pushed below the barrier.
 *
 * `Asia/Makassar` is a fixed UTC+8 with no DST, so converting a local midnight
 * to an instant is exact; there is no ambiguous or skipped hour to worry about
 * the way there would be for a DST zone.
 */

/**
 * Inclusive date range: `from`..`to` as WITA business days.
 *
 * The upper bound is exclusive-of-the-next-day rather than inclusive-of-`to`,
 * which is what makes it a clean half-open interval and avoids the classic
 * "misses the last day's evening sales" bug that `<= to::date` invites.
 *
 * @param column qualified column, e.g. `s.occurred_at`
 * @param fromParam 1-based bind index holding the first business date
 * @param toParam 1-based bind index holding the last business date
 */
export function witaDateRange(column: string, fromParam: number, toParam: number): string {
  return (
    `${column} >= ($${fromParam}::date)::timestamp AT TIME ZONE 'Asia/Makassar' ` +
    `AND ${column} < (($${toParam}::date) + 1)::timestamp AT TIME ZONE 'Asia/Makassar'`
  );
}

/**
 * A single WITA business day — the equivalent of
 * `(column AT TIME ZONE 'Asia/Makassar')::date = $n`.
 */
export function witaDateEquals(column: string, dateParam: number): string {
  return witaDateRange(column, dateParam, dateParam);
}
