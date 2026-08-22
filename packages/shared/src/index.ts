/**
 * `@mimi/shared` public surface — frozen after Gate G1 (BUILD-PLAN §6 rule 4).
 * Export deliberately: every backend module, the frontend, and
 * `@mimi/sync-protocol` import from here, never from a subpath directly.
 */

// Wire type aliases (Money/Qty/Temp/UUID/ISODate/ISODateTime, Paginated, ApiErrorShape)
export * from './types';

// Enums — CONTRACTS.md §2, verbatim
export * from './enums';

// RBAC matrix — CONTRACTS.md §3, verbatim, + can()/permissionsForRole()/rolesWithPermission()
export * from './rbac';

// Error codes (machine keys for the exception filter's `code` field)
export * from './error-codes';

// Global constants (WITA, IDR, geofence default, approval thresholds, doc-numbering formats)
export * from './constants';
export * from './doc-number';

// Decimal-safe arithmetic (D-10) — the fixed-point core plus Money/Qty/Temp wrappers
export * from './decimal/fixed-point';
export * from './money';
export * from './qty';
export * from './temp';

// WITA date utilities (D-11)
export * from './wita';

// Approval state machines — CONTRACTS.md §5, as data + transition()
export * from './approvals/state-machine';

// Payroll calculators — PIN-01..07 / POUT-01..09 + D-18 statutory layer
export * from './payroll';

// GL — chart of accounts, posting rules (§6 as data), balance validator
export * from './gl/chart-of-accounts';
export * from './gl/posting-rules';
export * from './gl/validator';

// Cart / sale total calculator + GoFood/ShopeeFood net-received math
export * from './cart';

// API resource shapes (CONTRACTS.md §4 core interfaces)
export * from './interfaces';

// B-17 — offline credential unlock codes, shared so the device and the server
// cannot drift on the derivation (see that file's header for why that matters).
export * from './offline/unlock-code';

// D-27 — the recipe-explosion formula, shared so `modules/product` and
// `modules/pos` cannot drift on it again (they already did once).
export * from './recipe/explosion';
