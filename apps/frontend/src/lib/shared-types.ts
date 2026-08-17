/**
 * The one seam between the frontend and `@mimi/shared` (owned by W1-B, whose
 * package is frozen after G1 per collision rule §6.4). Every other frontend
 * file that needs a wire type, enum, or shared interface imports it from
 * HERE, not from '@mimi/shared' directly — if W1-B's export names ever
 * change, this is the only file that needs to change with them.
 */

// Wire primitives (CONTRACTS §0) — money/qty/temp travel as decimal strings,
// never JS numbers. UUID/ISODate/ISODateTime are branded-in-spirit aliases.
export type { Money, Qty, Temp, UUID, ISODate, ISODateTime } from '@mimi/shared';

// Standard list envelope + exception-filter error shape (CONTRACTS §0)
export type { Paginated, ApiErrorShape } from '@mimi/shared';

// Roles (CONTRACTS §2.1 / §3 columns) + the literal permission-key union and
// its helpers, transcribed verbatim from CONTRACTS §3 (137 keys).
export { RoleKey } from '@mimi/shared';
export type { PermissionKey } from '@mimi/shared';
export { can as roleCan, permissionsForRole, rolesWithPermission } from '@mimi/shared';

// Approval engine (CONTRACTS §2.5, D-08) — used by ApprovalTimeline
export {
  ApprovalState,
  ApprovalStepState,
  ApprovalDocumentType,
  ReverificationStatus,
} from '@mimi/shared';

// Device / topology (CONTRACTS §2.9, D-13) — used by OfflineBanner / SyncStatusPill / F12
export { DeviceStatus } from '@mimi/shared';

// CONTRACTS §4.1 M01 auth shapes — the frontend's session store and login
// form use these directly rather than hand-rolling an equivalent shape.
export type { Me, LoginRes, OfflineCredentialRes } from '@mimi/shared';

// Stable machine error codes (CONTRACTS §0 `code` field) actually branched on
// in `lib/api.ts`/`lib/auth.ts`. The rest of the ~60-code vocabulary lives in
// `@mimi/shared`'s `error-codes.ts` for Wave 3–5 modules to import directly.
export { ERR_AUTH_INVALID_CREDENTIALS, ERR_AUTH_TOKEN_EXPIRED } from '@mimi/shared';
