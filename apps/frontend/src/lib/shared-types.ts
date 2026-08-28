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
// CONTRACTS §4.0 kernel shape — the canonical `ApprovalDetail`/`ApprovalStepDetail`
// (carries `currentStep`, the documented "chain finished once null" signal).
// Import THIS re-export rather than forking a module-local copy — several
// `components/*\/lib/types.ts` files forked their own before `currentStep`
// existed and lost the field as a result (see `components/approvals/lib/types.ts`).
export type { ApprovalDetail, ApprovalStepDetail } from '@mimi/shared';

// FR-ACCT-03 payment verification status — used wherever a document surfaces
// its linked `payment_verifications.status` (e.g. `PurchaseOrder.paymentStatus`).
export { PaymentStatus } from '@mimi/shared';

// Device / topology (CONTRACTS §2.9, D-13) — used by OfflineBanner / SyncStatusPill / F12
export { DeviceStatus, DeviceCategory } from '@mimi/shared';

// Purchasing (CONTRACTS §2.3/§4.11, W5-04) — PR/PO status ladders, used by
// `components/purchasing/**` for status-driven action gating.
export { PurchaseRequestStatus, PurchaseOrderStatus } from '@mimi/shared';

// CONTRACTS §4.1 M01 auth shapes — the frontend's session store and login
// form use these directly rather than hand-rolling an equivalent shape.
export type { Me, LoginRes, OfflineCredentialRes } from '@mimi/shared';

// M10 `delivery` (CONTRACTS §4.10, F-DELIVERY) — Surat Jalan / drop / cold
// chain status enums and the full wire interfaces. Used by
// `components/delivery/**`; imported here rather than redeclared, per this
// file's own header contract ("do not redeclare").
export { SuratJalanStatus, DropStatus, ShipmentType, SealStatus, TempLogStage } from '@mimi/shared';
export type { SuratJalan, Drop, DropLine, Seal, TempLog } from '@mimi/shared';
// Route planning + live tracking (migration 221 / M10 delivery).
export type { SjPosition, LiveDelivery } from '@mimi/shared';

// M08 `stock-opname` (CONTRACTS §4.8, F-WAREHOUSE) — verified field-for-field
// against `stock-opname.service.ts`'s `toOpname`/`toOpnameLine` mappers
// (unlike `PurchaseOrder` below, these two are NOT known to drift from the
// live response), so they're imported here rather than redeclared, per this
// file's own header contract. Used by both `components/outlet` and
// `components/warehouse` (each runs its own opname against its own location).
export { OpnameStatus } from '@mimi/shared';
export type { Opname, OpnameLine } from '@mimi/shared';

// Stable machine error codes (CONTRACTS §0 `code` field) actually branched on
// in `lib/api.ts`/`lib/auth.ts`. The rest of the ~60-code vocabulary lives in
// `@mimi/shared`'s `error-codes.ts` for Wave 3–5 modules to import directly.
export { ERR_AUTH_INVALID_CREDENTIALS, ERR_AUTH_TOKEN_EXPIRED } from '@mimi/shared';

// F-DOC (2026-08-27) — the document designers (invoice / receipt / voucher /
// Surat Jalan) and the brand identity every printed document is coloured from.
//
// These come through this seam rather than being deep-imported by
// `components/documents/**` because they are the widest shared surface added
// since the delivery types: the designer, the renderer, four print routes, the
// POS receipt path and the Brand panel all name them. `DOC_CATALOGS`,
// `defaultDocTemplate`, `validateDocTemplate` and `resolveDocColor` are VALUE
// exports (runtime functions/data), so they are re-exported as values, not
// types — `isolatedModules` makes that distinction load-bearing.
export type {
  DocKind,
  DocPaper,
  DocAlign,
  DocElement,
  DocElementType,
  DocTableColumn,
  DocTemplate,
  DocColor,
  BrandColorToken,
  BrandPalette,
  DocCatalog,
  DocData,
  DocItemRow,
  DocTotalRow,
  DocPayload,
  DocPayloadTotalRow,
  DocCopySet,
  InvoiceSource,
} from '@mimi/shared';
export {
  DOC_KINDS,
  DOC_PAPERS,
  DOC_PAPER_SIZES,
  DOC_ELEMENT_TYPES,
  DOC_CATALOGS,
  DOC_TOTALS_ROWS,
  DOC_TEMPLATE_LIMITS,
  DOC_TEMPLATE_VERSION,
  BRAND_COLOR_TOKENS,
  INVOICE_SOURCES,
  isDocKind,
  isInvoiceSource,
  isValidDocColor,
  resolveDocColor,
  emptyDocData,
  defaultDocTemplate,
  validateDocTemplate,
} from '@mimi/shared';

// Brand identity — the favicon + the four document colours. The LOGO is not
// here: it stays on `company.profile.logoAttachmentId` (see the header of
// `packages/shared/src/brand.ts` for why duplicating it would guarantee one
// screen prints a blank letterhead).
export type { BrandIdentity } from '@mimi/shared';
export { DEFAULT_BRAND_IDENTITY, DEFAULT_BRAND_PALETTE, brandPalette } from '@mimi/shared';

// Vouchers — the redemption rules the till previews with and the server
// decides with. `checkVoucher` is shared precisely so an offline till and the
// server cannot disagree about what a coupon is worth (see
// `packages/shared/src/voucher/index.ts`).
export { VoucherType, VoucherStatus, VoucherBatchStatus } from '@mimi/shared';
export type {
  VoucherRules,
  VoucherRejection,
  VoucherCheckInput,
  VoucherCheckResult,
  VoucherRedemptionDraft,
  VoucherOfflinePolicy,
} from '@mimi/shared';
export {
  checkVoucher,
  normalizeVoucherCode,
  isVoucherCode,
  formatVoucherCode,
  VOUCHER_CODE_PREFIX,
  VOUCHER_CODE_ALPHABET,
  DEFAULT_VOUCHER_OFFLINE_POLICY,
} from '@mimi/shared';
