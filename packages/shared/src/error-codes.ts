/**
 * Machine-readable error codes (CONTRACTS.md §0's exception-filter shape:
 * `{ statusCode, code, message, details? }`). `code` is a stable key the
 * frontend i18n layer resolves to Bahasa Indonesia text — this package holds
 * no user-facing strings (constraint: English identifiers/comments only).
 *
 * Codes explicitly named in CONTRACTS.md/SYNC-PROTOCOL.md are transcribed
 * verbatim; the rest follow the same `ERR_<DOMAIN>_<REASON>` convention so a
 * new one is easy to place correctly.
 *
 * All codes live in one `as const` object (`ERROR_CODES`) so `ErrorCode` — the
 * type `ApiErrorShape.code` (`./types`) actually uses — is a closed union
 * derived from this single list, the same discipline as `PermissionKey` in
 * `./rbac`: a hand-typed code that doesn't exist is a compile error at the
 * comparison site, not a silent `false`/no-match. Each historical named
 * export (`ERR_STOCK_INSUFFICIENT`, etc.) is destructured back out below so
 * every existing import site is unaffected.
 */

const ERROR_CODES = {
  // ── Auth / RLS / RBAC ─────────────────────────────────────────────────────
  ERR_AUTH_INVALID_CREDENTIALS: 'ERR_AUTH_INVALID_CREDENTIALS',
  ERR_AUTH_TOKEN_EXPIRED: 'ERR_AUTH_TOKEN_EXPIRED',
  ERR_AUTH_TOKEN_INVALID: 'ERR_AUTH_TOKEN_INVALID',
  ERR_AUTH_PIN_INVALID: 'ERR_AUTH_PIN_INVALID',
  ERR_AUTH_PIN_LOCKED: 'ERR_AUTH_PIN_LOCKED',
  /** PermissionsGuard 403. */
  ERR_FORBIDDEN: 'ERR_FORBIDDEN',
  /** Explicit `locationId` outside the caller's scope. */
  ERR_LOCATION_OUT_OF_SCOPE: 'ERR_LOCATION_OUT_OF_SCOPE',

  // ── Reason / evidence requirements (FR-AUDIT-02, FR-LOG-13, FR-SO-02, wajib foto) ──
  ERR_REASON_REQUIRED: 'ERR_REASON_REQUIRED',
  ERR_VARIANCE_REASON_REQUIRED: 'ERR_VARIANCE_REASON_REQUIRED',
  ERR_PHOTO_REQUIRED: 'ERR_PHOTO_REQUIRED',
  ERR_SIGNATURE_REQUIRED: 'ERR_SIGNATURE_REQUIRED',
  ERR_PROOF_REQUIRED: 'ERR_PROOF_REQUIRED',

  // ── Approval engine (D-08) ────────────────────────────────────────────────
  ERR_APPROVAL_STEP_ROLE: 'ERR_APPROVAL_STEP_ROLE',
  ERR_APPROVAL_INVALID_TRANSITION: 'ERR_APPROVAL_INVALID_TRANSITION',
  ERR_APPROVAL_ALREADY_DECIDED: 'ERR_APPROVAL_ALREADY_DECIDED',
  /** C1 opname disputes block submit→approve. */
  ERR_DISPUTES_OPEN: 'ERR_DISPUTES_OPEN',
  /** Action attempted offline outside SYNC-PROTOCOL §7.6's closed list. */
  ERR_OFFLINE_NOT_ELIGIBLE: 'ERR_OFFLINE_NOT_ELIGIBLE',

  // ── Stock / inventory (D-07, D-15, D-17a) ────────────────────────────────
  /** Strict-mode ledger rejection only. */
  ERR_STOCK_INSUFFICIENT: 'ERR_STOCK_INSUFFICIENT',
  /** Cannot deactivate a storage area with balance ≠ 0. */
  ERR_AREA_HAS_STOCK: 'ERR_AREA_HAS_STOCK',
  /** Frozen+dry sharing one SJ (FR-LOG-02). */
  ERR_SHIPMENT_TYPE_MIX: 'ERR_SHIPMENT_TYPE_MIX',

  // ── HR / attendance (FR-HR-01) ────────────────────────────────────────────
  ERR_GEOFENCE_OUT_OF_RANGE: 'ERR_GEOFENCE_OUT_OF_RANGE',

  // ── Payroll (D-18 statutory gate) ────────────────────────────────────────
  ERR_STATUTORY_NOT_READY: 'ERR_STATUTORY_NOT_READY',
  /** `payroll.statutory` flipped only via the enable/disable endpoints. */
  ERR_USE_WIZARD: 'ERR_USE_WIZARD',
  /** `bpjs_configs` / `pph21_*` effective windows overlapped. */
  ERR_EFFECTIVE_OVERLAP: 'ERR_EFFECTIVE_OVERLAP',
  /** `pph21_ter_rates`/`pph21_article17_brackets` brackets not contiguous from 0. */
  ERR_BRACKET_GAP: 'ERR_BRACKET_GAP',

  // ── POS / sales ───────────────────────────────────────────────────────────
  /** Online order net ≠ gross − discount − fees. */
  ERR_NET_MISMATCH: 'ERR_NET_MISMATCH',

  // ── Accounting / GL (D-04) ────────────────────────────────────────────────
  ERR_UNBALANCED_ENTRY: 'ERR_UNBALANCED_ENTRY',
  ERR_PERIOD_CLOSED: 'ERR_PERIOD_CLOSED',

  // ── Sync protocol permanent rejects (SYNC-PROTOCOL §4.4; mirrors SyncRejectCode) ──
  ERR_SYNC_AUTHORITY_VIOLATION: 'ERR_SYNC_AUTHORITY_VIOLATION',
  ERR_SYNC_MALFORMED: 'ERR_SYNC_MALFORMED',
  ERR_SYNC_SEQ_CONFLICT: 'ERR_SYNC_SEQ_CONFLICT',
  ERR_SYNC_PAYLOAD_VERSION_UNSUPPORTED: 'ERR_SYNC_PAYLOAD_VERSION_UNSUPPORTED',

  // ── Sync admin (CONTRACTS.md §4.23 conflict/reconciliation queues, F12) ────
  /** `POST /api/sync/conflicts/:id/dismiss` on an entry that needs domain-UI resolution (opname/refund/etc.) rather than a bare dismiss (§5.4's "resolution always happens in the owning domain UI"). */
  ERR_RESOLVE_IN_DOMAIN: 'ERR_RESOLVE_IN_DOMAIN',

  // ── Node gateway / device registry (D-12/D-13, BUILD-PLAN D-26) ──────────
  /** `PUT /api/nodes/outlet-setting/:locationId {nodeEnabled:false}` refused — the node's relay
   *  outbox is non-empty per its last fresh heartbeat (drain-before-off, D-26). */
  ERR_NODE_QUEUE_PENDING: 'ERR_NODE_QUEUE_PENDING',
  /** Same endpoint, refused because the node's queue depth cannot be verified right now (no live
   *  `/bridge` connection, or its last self-reported reading is stale) — an unreachable node with a
   *  possible backlog must never be silently switched off (D-26). */
  ERR_NODE_UNREACHABLE: 'ERR_NODE_UNREACHABLE',

  // ── Generic ───────────────────────────────────────────────────────────────
  ERR_NOT_FOUND: 'ERR_NOT_FOUND',
  ERR_VALIDATION: 'ERR_VALIDATION',
  ERR_CONFLICT: 'ERR_CONFLICT',
  /**
   * Added by W1-D (apps/backend/src/common/filters/all-exceptions.filter.ts):
   * the one genuinely-unmapped case the ErrorCode narrowing (commissioned by
   * the coordinator) didn't have a home for — an unhandled/unexpected
   * exception (a bug, a DB error, anything not already carrying its own
   * code) still has to emit SOMETHING in the CONTRACTS §0 shape. This is
   * that last-resort code, not a general-purpose escape hatch — every
   * exception with a knowable cause should use a specific code above it.
   */
  ERR_INTERNAL: 'ERR_INTERNAL',
} as const;

/** Closed union of every machine error code — see the file header. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Every error code, for iteration/validation (e.g. a test asserting an OpenAPI enum matches). */
export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.values(ERROR_CODES);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODE_LIST);

/**
 * The runtime type guard for `ErrorCode`, derived from `ERROR_CODE_LIST` —
 * itself derived from `ERROR_CODES` above. There is exactly one place that
 * knows the set of valid codes; this function and the `ErrorCode` type are
 * two views of it, not two maintained lists. An exception filter (W1-D's
 * `all-exceptions.filter.ts`) or any other runtime boundary that receives a
 * plain string and needs to know whether it's a real code (e.g. before
 * trusting a value from an external system, a legacy log line, or a value
 * that merely LOOKS like a code) should call this rather than hand-rolling
 * an `Object.values(...).includes(x)` check or its own copy of the list.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export const {
  ERR_AUTH_INVALID_CREDENTIALS,
  ERR_AUTH_TOKEN_EXPIRED,
  ERR_AUTH_TOKEN_INVALID,
  ERR_AUTH_PIN_INVALID,
  ERR_AUTH_PIN_LOCKED,
  ERR_FORBIDDEN,
  ERR_LOCATION_OUT_OF_SCOPE,
  ERR_REASON_REQUIRED,
  ERR_VARIANCE_REASON_REQUIRED,
  ERR_PHOTO_REQUIRED,
  ERR_SIGNATURE_REQUIRED,
  ERR_PROOF_REQUIRED,
  ERR_APPROVAL_STEP_ROLE,
  ERR_APPROVAL_INVALID_TRANSITION,
  ERR_APPROVAL_ALREADY_DECIDED,
  ERR_DISPUTES_OPEN,
  ERR_OFFLINE_NOT_ELIGIBLE,
  ERR_STOCK_INSUFFICIENT,
  ERR_AREA_HAS_STOCK,
  ERR_SHIPMENT_TYPE_MIX,
  ERR_GEOFENCE_OUT_OF_RANGE,
  ERR_STATUTORY_NOT_READY,
  ERR_USE_WIZARD,
  ERR_EFFECTIVE_OVERLAP,
  ERR_BRACKET_GAP,
  ERR_NET_MISMATCH,
  ERR_UNBALANCED_ENTRY,
  ERR_PERIOD_CLOSED,
  ERR_RESOLVE_IN_DOMAIN,
  ERR_NODE_QUEUE_PENDING,
  ERR_NODE_UNREACHABLE,
  ERR_SYNC_AUTHORITY_VIOLATION,
  ERR_SYNC_MALFORMED,
  ERR_SYNC_SEQ_CONFLICT,
  ERR_SYNC_PAYLOAD_VERSION_UNSUPPORTED,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_CONFLICT,
  ERR_INTERNAL,
} = ERROR_CODES;
