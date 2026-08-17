/**
 * JWT payload shapes (CONTRACTS.md §4.1 `auth`).
 *
 * `roleKey` is typed `string` here rather than importing the `RoleKey` enum
 * from `@mimi/shared` because the string values are CONTRACTS §2.1's contract
 * (`'owner' | 'manager' | ... | 'driver'`), and this file only needs to carry
 * the claim, not branch on it — ScopeService and PermissionsGuard are the ones
 * that interpret it. When `@mimi/shared` publishes `RoleKey` (W1-B, in
 * progress), tighten this to `RoleKey` — a type-only change, not a logic one.
 *
 * `locationIds` here is the user's RAW `user_locations` assignment (what
 * `/api/auth/me` calls `locations`) — a coarse, cheap-to-carry hint. It is
 * NOT the authoritative RLS scope: `RlsContextGuard` always recomputes the
 * effective scope per request via `ScopeService` (Kepala Gudang's shipping
 * destinations and a Driver's active-SJ outlets change more often than a
 * 15-minute access token's lifetime allows this claim to track).
 */
export interface JwtAccessPayload {
  /** `users.id` */
  sub: string;
  username: string;
  roleKey: string;
  locationIds: string[];
}

/**
 * Refresh-token claim. Deliberately minimal: `sessionId` ties back to the
 * `sessions` row (`refresh_token_hash`, `revoked_at`) so M01 `auth` can reject
 * a reused or revoked refresh token even though the JWT itself still verifies
 * — the session row is the actual revocation authority, this token is just
 * the bearer credential naming which row to check.
 */
export interface JwtRefreshPayload {
  sub: string;
  sessionId: string;
}
