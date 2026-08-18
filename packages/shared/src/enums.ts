/**
 * Every enum from CONTRACTS.md §2, transcribed verbatim (TS keys SCREAMING_SNAKE,
 * string values lower_snake — CONTRACTS.md §0 naming convention). These string
 * values MUST match W1-C's DB CHECK constraints character-for-character; a
 * mismatch is a G1 blocker (BUILD-PLAN §5 W1-B).
 *
 * Source: docs/CONTRACTS.md §2, as amended (D-18 statutory payroll / Amendment 1,
 * D-19 cash-variance proposals / Amendment 2, both landed before this file was
 * written — see the package README/report for the sequencing note). D-20
 * (supplier column visibility) had NOT landed a new enum by the time this file
 * was written; only `rbac.ts`'s new `supplier.directory.read` key reflects it.
 *
 * Do not hand-edit a value here without a corresponding architect amendment to
 * CONTRACTS.md — this package is read-only to every other agent after Gate G1
 * (BUILD-PLAN §6 rule 4).
 */

// ── §2.1 Core / location ──────────────────────────────────────────────────────

export enum LocationType {
  WAREHOUSE = 'warehouse',
  OUTLET = 'outlet',
}

/** D-15: typed storage areas inside a location. Stock is keyed by (location, area, item). */
export enum StorageAreaType {
  FREEZER = 'freezer',
  CHILLER = 'chiller',
  DRY_STORE = 'dry_store',
  DISPLAY = 'display',
  KITCHEN_LINE = 'kitchen_line',
}

/** The 9 role columns of §3's RBAC matrix. */
export enum RoleKey {
  OWNER = 'owner',
  MANAGER = 'manager',
  FINANCE = 'finance',
  KEPALA_GUDANG = 'kepala_gudang',
  SUPERVISOR = 'supervisor',
  LEADER_OUTLET = 'leader_outlet',
  KASIR = 'kasir',
  HR_ADMIN = 'hr_admin',
  /** Added by D-14 (Appendix A-2) — Surat Jalan needs a driver actor the PRD's 8 roles don't cover. */
  DRIVER = 'driver',
  /**
   * Added 2026-08-18 (owner request): an all-access technical account that can
   * reach EVERY interface, distinct from `OWNER` so "the boss's login" and
   * "the account that can see everything" need not be the same credential.
   *
   * Holds every permission in the matrix by construction (see `rbac.ts`) and is
   * treated as central by RLS (`app_is_central()`, migration 222) — without
   * that second half it would pass every permission check and still see no
   * rows. Deliberately LAST in `RBAC_ROLE_ORDER` so adding it shifted no
   * existing column index in the 138-row matrix.
   */
  SUPERADMIN = 'superadmin',
}

// ── §2.2 Stock & logistics ────────────────────────────────────────────────────

/** stock_movements.movement_type; sign is encoded in the suffix (_in / _out). */
export enum MovementType {
  OPENING_BALANCE = 'opening_balance',
  PURCHASE_IN = 'purchase_in',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
  USAGE_OUT = 'usage_out',
  WASTE_OUT = 'waste_out',
  RETURN_IN = 'return_in',
  RETURN_OUT = 'return_out',
  ADJUSTMENT_IN = 'adjustment_in',
  ADJUSTMENT_OUT = 'adjustment_out',
}

/** FR-LOG-11 — exactly these 9 states. */
export enum ReplenishmentStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  AWAITING_APPROVAL = 'awaiting_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  RECEIVED = 'received',
  COMPLETED = 'completed',
}

export enum ReplenishmentSource {
  MANUAL = 'manual',
  AUTO_SUGGESTION = 'auto_suggestion',
}

export enum SuratJalanStatus {
  DRAFT = 'draft',
  READY = 'ready',
  LOADING = 'loading',
  IN_TRANSIT = 'in_transit',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum DropStatus {
  PENDING = 'pending',
  EN_ROUTE = 'en_route',
  ARRIVED = 'arrived',
  COMPLETED = 'completed',
  COMPLETED_DISCREPANCY = 'completed_discrepancy',
  FAILED = 'failed',
}

/** FR-LOG-02 — rows seeded in `shipment_types`. */
export enum ShipmentType {
  FROZEN = 'frozen',
  DRY = 'dry',
}

export enum TempLogStage {
  LOAD = 'load',
  DEPART = 'depart',
  ARRIVE = 'arrive',
}

export enum SealStatus {
  APPLIED = 'applied',
  VERIFIED_INTACT = 'verified_intact',
  BROKEN = 'broken',
  REPLACED = 'replaced',
}

export enum GoodsReceiptType {
  SJ_DROP = 'sj_drop',
  RETURN_IN = 'return_in',
}

export enum OpnameStatus {
  DRAFT = 'draft',
  COUNTING = 'counting',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ADJUSTED = 'adjusted',
  CANCELLED = 'cancelled',
}

export enum AdjustmentSource {
  OPNAME = 'opname',
  MANUAL = 'manual',
  RECONCILIATION = 'reconciliation',
}

export enum WasteReason {
  EXPIRED = 'expired',
  DAMAGED = 'damaged',
  LOST = 'lost',
  CONTAMINATED = 'contaminated',
  COLD_CHAIN_BREACH = 'cold_chain_breach',
  PRODUCTION_ERROR = 'production_error',
  OTHER = 'other',
}

export enum WasteStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum ReturnDirection {
  OUTLET_TO_WAREHOUSE = 'outlet_to_warehouse',
  WAREHOUSE_TO_SUPPLIER = 'warehouse_to_supplier',
}

export enum ReturnStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum ReturnCondition {
  DAMAGED = 'damaged',
  EXPIRED = 'expired',
  WRONG_ITEM = 'wrong_item',
  QUALITY = 'quality',
  OTHER = 'other',
}

export enum ItemStorageType {
  FROZEN = 'frozen',
  CHILLED = 'chilled',
  DRY = 'dry',
}

// ── §2.3 Purchasing ───────────────────────────────────────────────────────────

export enum PurchaseRequestStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CONVERTED = 'converted',
  CANCELLED = 'cancelled',
}

export enum PurchaseOrderStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  ISSUED = 'issued',
  PARTIALLY_RECEIVED = 'partially_received',
  RECEIVED = 'received',
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
}

export enum PettyCashStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

// ── §2.4 POS & payments ───────────────────────────────────────────────────────

export enum ShiftStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum SaleStatus {
  COMPLETED = 'completed',
  VOIDED = 'voided',
  REFUNDED = 'refunded',
}

/** FR-POS-04. */
export enum PaymentMethod {
  CASH = 'cash',
  QRIS = 'qris',
  BANK_TRANSFER = 'bank_transfer',
}

/** FR-ACCT-03. */
export enum PaymentStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  PAID = 'paid',
}

export enum VoidRefundType {
  VOID = 'void',
  REFUND = 'refund',
}

export enum VoidRefundStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/** FR-POS-05/07. */
export enum OnlinePlatform {
  GOFOOD = 'gofood',
  SHOPEEFOOD = 'shopeefood',
}

export enum OnlineOrderStatus {
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum SettlementStatus {
  PENDING = 'pending',
  SETTLED = 'settled',
}

/** D-19 / Amendment 2 — shift-close shortfall auto-propose, human-approve. */
export enum CashVarianceProposalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

// ── §2.5 Approvals (D-08) ─────────────────────────────────────────────────────

export enum ApprovalState {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

export enum ApprovalStepState {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SKIPPED = 'skipped',
}

export enum ApprovalAction {
  SUBMIT = 'submit',
  APPROVE = 'approve',
  REJECT = 'reject',
  AMEND = 'amend',
  CANCEL = 'cancel',
}

export enum ApprovalDocumentType {
  REPLENISHMENT_REQUEST = 'replenishment_request',
  VOID_REFUND = 'void_refund',
  PURCHASE_REQUEST = 'purchase_request',
  PURCHASE_ORDER = 'purchase_order',
  STOCK_OPNAME = 'stock_opname',
  RETURN = 'return',
  PAYROLL_RUN = 'payroll_run',
  PAYMENT_VERIFICATION = 'payment_verification',
  LEAVE_REQUEST = 'leave_request',
  EMPLOYEE_LOAN = 'employee_loan',
  /** D-19 / Amendment 2. */
  CASH_VARIANCE_PROPOSAL = 'cash_variance_proposal',
  /** Added per architect follow-up to the W1-B report's finding #2 (§5.10 waste chain had no enum member); W1-C adds the matching DB CHECK constraint value. */
  WASTE = 'waste',
}

/** D-17, SYNC-PROTOCOL §7.4 — the three-valued outcome of re-verifying an offline approval. */
export enum ReverificationStatus {
  VERIFIED = 'verified',
  FAILED = 'failed',
  UNPROVABLE = 'unprovable',
}

/**
 * BUILD-PLAN D-23 (owner-decided) — per-`ApprovalDocumentType` mode,
 * Owner-configurable via `settings['approval.mode']` (M20, `settings.approval_mode.manage`).
 * Not yet reflected in CONTRACTS.md §2.5's own enum block — same kind of
 * documented drift `rbac.ts`'s header already flags for the 137-vs-131
 * permission-key count; flagged here for the architect to fold into a future
 * CONTRACTS.md amendment rather than silently left undocumented.
 *
 * - `MANUAL` — approval required; request notified in-app + email (today's default behaviour).
 * - `WHATSAPP` — approval required; request notified via WhatsApp. D-24: WA is a
 *   notification channel only — the message carries a deep link into the authenticated
 *   app where the real decision happens; a WA reply never approves anything.
 * - `AUTO` — the system auto-creates the approval request; a human still decides.
 *   Automates the REQUEST, never the DECISION.
 * - `OFF` — no approval step required, but the actor, timestamp, and resulting
 *   document state are still recorded (`ApprovalService.submit()` auto-records a
 *   decided step instead of skipping bookkeeping entirely) — nothing becomes anonymous.
 */
export enum ApprovalMode {
  MANUAL = 'manual',
  WHATSAPP = 'whatsapp',
  AUTO = 'auto',
  OFF = 'off',
}

// ── §2.6 HR & payroll ─────────────────────────────────────────────────────────

export enum EmploymentStatus {
  ACTIVE = 'active',
  PROBATION = 'probation',
  RESIGNED = 'resigned',
  TERMINATED = 'terminated',
}

export enum AttendanceStatus {
  PRESENT = 'present',
  LATE = 'late',
  /** = alpha (POUT-03). */
  ABSENT = 'absent',
  SICK = 'sick',
  PERMISSION = 'permission',
  LEAVE = 'leave',
  HOLIDAY = 'holiday',
  OFF = 'off',
}

export enum LeaveType {
  /** cuti tahunan, 12 hari default (POUT-04). */
  ANNUAL = 'annual',
  /** cuti nikah, 3 hari default (POUT-04). */
  MARRIAGE = 'marriage',
  /** POUT-01. */
  SICK = 'sick',
  /** izin (POUT-02). */
  PERMISSION = 'permission',
  UNPAID = 'unpaid',
}

export enum LeaveStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

export enum PayrollComponentType {
  EARNING = 'earning',
  DEDUCTION = 'deduction',
  /** D-18 / Amendment 1 — BPJS employer shares: company cost, never net-pay-affecting. */
  EMPLOYER_COST = 'employer_cost',
}

/**
 * The full salary-component code space. Two visibly distinct groups per the
 * D-18 contract:
 *  - PRD BASE (7 PIN + 9 POUT): always active, computed regardless of the
 *    statutory flag.
 *  - STATUTORY (D-18 / Amendment 1): `is_statutory = true` in `salary_components`;
 *    computed ONLY when `settings['payroll.statutory'].enabled === true`. When
 *    the flag is off, none of these codes appear on any payslip line — see
 *    `payroll/statutory.ts`'s `statutoryOff ≡ base result` property test.
 */
export enum PayrollComponentCode {
  // ── PRD BASE components (the 7 PIN + 9 POUT; always active) ─────────────────
  BASE_SALARY = 'base_salary', // PIN-01
  OVERTIME = 'overtime', // PIN-02 (formula: attendance overtime_minutes)
  ATTENDANCE_ALLOWANCE = 'attendance_allowance', // PIN-03
  PERFORMANCE_INCENTIVE = 'performance_incentive', // PIN-04
  TENURE_ALLOWANCE = 'tenure_allowance', // PIN-05 (formula: join_date)
  POSITION_ALLOWANCE = 'position_allowance', // PIN-06
  OTHER_EARNING = 'other_earning', // PIN-07
  DEDUCTION_SICK = 'deduction_sick', // POUT-01
  DEDUCTION_PERMISSION = 'deduction_permission', // POUT-02
  DEDUCTION_ABSENCE = 'deduction_absence', // POUT-03 (alpha)
  DEDUCTION_LEAVE_EXCESS = 'deduction_leave_excess', // POUT-04 (beyond quota)
  DEDUCTION_STOCK_SHORTFALL = 'deduction_stock_shortfall', // POUT-05 (from approved SO diff)
  DEDUCTION_LOAN_INSTALLMENT = 'deduction_loan_installment', // POUT-06 (kasbon amortization)
  DEDUCTION_LATE = 'deduction_late', // POUT-07 (+ POUT-08 attendance-data basis, Appendix A-6)
  OTHER_DEDUCTION = 'other_deduction', // POUT-09
  /** D-19 / Amendment 2 — an approved shift cash-shortfall proposal (POUT-09 family). */
  DEDUCTION_CASH_VARIANCE = 'deduction_cash_variance',
  // ── STATUTORY components (D-18 / Amendment 1; compute ONLY when payroll.statutory enabled) ──
  /** deduction, 1% employee share. */
  BPJS_KESEHATAN_EMPLOYEE = 'bpjs_kesehatan_employee',
  /** deduction, 2% employee share. */
  BPJS_JHT_EMPLOYEE = 'bpjs_jht_employee',
  /** deduction, 1% employee share, capped. */
  BPJS_JP_EMPLOYEE = 'bpjs_jp_employee',
  /** deduction — TER monthly withholding; Article-17 true-up in December. */
  PPH21 = 'pph21',
  /** employer_cost, 4% employer share. */
  BPJS_KESEHATAN_EMPLOYER = 'bpjs_kesehatan_employer',
  /** employer_cost, 3.7% employer share. */
  BPJS_JHT_EMPLOYER = 'bpjs_jht_employer',
  /** employer_cost — risk-class rate, employer-only (no employee share exists). */
  BPJS_JKK_EMPLOYER = 'bpjs_jkk_employer',
  /** employer_cost, 0.3%, employer-only (no employee share exists). */
  BPJS_JKM_EMPLOYER = 'bpjs_jkm_employer',
  /** employer_cost, 2% employer share, capped. */
  BPJS_JP_EMPLOYER = 'bpjs_jp_employer',
}

export enum PayrollRunStatus {
  DRAFT = 'draft',
  CALCULATED = 'calculated',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

export enum LoanStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  PAID_OFF = 'paid_off',
  WRITTEN_OFF = 'written_off',
  REJECTED = 'rejected',
}

// ── §2.7 Assets ────────────────────────────────────────────────────────────────

export enum AssetCategory {
  MACHINE = 'machine',
  VEHICLE = 'vehicle',
  EQUIPMENT = 'equipment',
  ELECTRONICS = 'electronics',
  FURNITURE = 'furniture',
  OTHER = 'other',
}

export enum AssetCondition {
  GOOD = 'good',
  FAIR = 'fair',
  POOR = 'poor',
  BROKEN = 'broken',
}

export enum AssetStatus {
  ACTIVE = 'active',
  IN_MAINTENANCE = 'in_maintenance',
  RETIRED = 'retired',
  LOST = 'lost',
}

export enum MaintenanceJobStatus {
  SCHEDULED = 'scheduled',
  DUE = 'due',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
  VERIFIED = 'verified',
  SKIPPED = 'skipped',
}

export enum MaintenanceJobType {
  SCHEDULED = 'scheduled',
  CORRECTIVE = 'corrective',
}

// ── §2.8 Accounting ────────────────────────────────────────────────────────────

export enum AccountType {
  ASSET = 'asset',
  LIABILITY = 'liability',
  EQUITY = 'equity',
  REVENUE = 'revenue',
  EXPENSE = 'expense',
}

export enum NormalBalance {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum FiscalPeriodStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  LOCKED = 'locked',
}

export enum JournalEntryStatus {
  POSTED = 'posted',
  REVERSED = 'reversed',
}

/** The 16 PRD journal event types (§6.2). */
export enum JournalEventType {
  GUDANG_PURCHASE = 'gudang_purchase', // FR-ACC-JGUD-01
  GUDANG_GOODS_IN = 'gudang_goods_in', // FR-ACC-JGUD-02
  GUDANG_GOODS_OUT_TO_OUTLET = 'gudang_goods_out_to_outlet', // FR-ACC-JGUD-03
  GUDANG_RETURN_TO_SUPPLIER = 'gudang_return_to_supplier', // FR-ACC-JGUD-04
  GUDANG_WASTE = 'gudang_waste', // FR-ACC-JGUD-05
  GUDANG_STOCK_ADJUSTMENT = 'gudang_stock_adjustment', // FR-ACC-JGUD-06
  GUDANG_STOCK_REVALUATION = 'gudang_stock_revaluation', // FR-ACC-JGUD-07
  OUTLET_GOODS_IN_FROM_WAREHOUSE = 'outlet_goods_in_from_warehouse', // FR-ACC-JOUT-01
  OUTLET_INGREDIENT_USAGE = 'outlet_ingredient_usage', // FR-ACC-JOUT-02
  OUTLET_SALES = 'outlet_sales', // FR-ACC-JOUT-03
  OUTLET_WASTE = 'outlet_waste', // FR-ACC-JOUT-04
  OUTLET_RETURN_TO_WAREHOUSE = 'outlet_return_to_warehouse', // FR-ACC-JOUT-05
  OUTLET_STOCK_ADJUSTMENT = 'outlet_stock_adjustment', // FR-ACC-JOUT-06
  OUTLET_DIRECT_PURCHASE = 'outlet_direct_purchase', // FR-ACC-JOUT-07
  OUTLET_PETTY_CASH = 'outlet_petty_cash', // FR-ACC-JOUT-08
  OUTLET_OPERATING_EXPENSE = 'outlet_operating_expense', // FR-ACC-JOUT-09
}

/** D-04 extensions beyond the PRD's 16 (§6.3). */
export enum JournalSystemEventType {
  PAYROLL_ACCRUAL = 'payroll_accrual',
  PAYROLL_PAYMENT = 'payroll_payment',
  QRIS_SETTLEMENT = 'qris_settlement',
  TRANSFER_VERIFIED = 'transfer_verified',
  PLATFORM_SETTLEMENT = 'platform_settlement',
  SALE_VOID_REVERSAL = 'sale_void_reversal',
  /** SYNC-PROTOCOL §7.5: failed offline approval w/ physical effect → claim receivable. */
  OFFLINE_AUTH_REJECTED = 'offline_auth_rejected',
  /**
   * §6.3's closing paragraph: "Petty-cash float top-up (Dr 1010 / Cr 1020)
   * ... post from their PV `paid` events under X-family rules." Named in
   * prose, in W1-C's migration 093 comment, and independently implemented by
   * W4-03 as an engine-side type + a `notes`-column marker (no enum existed
   * for either to key off) — the third independent discovery of this gap.
   * CONTRACTS.md's own `ref_type` value for this posting is `'petty_cash_topup'`
   * (same spelling) — no reconciliation needed here.
   */
  PETTY_CASH_TOPUP = 'petty_cash_topup',
  /**
   * Same §6.3 closing paragraph: "loan disbursement (Dr 1210 / Cr 1020) ...
   * under X-family rules (`ref_type='employee_loan'`)." Named
   * `employee_loan_disbursement` here rather than bare `employee_loan`
   * (CONTRACTS.md's own `ref_type` spelling) to distinguish the one-time
   * disbursement posting from the recurring installment leg already folded
   * into `PAYROLL_ACCRUAL` (POUT-06) — same event family, deliberately
   * un-ambiguous name.
   */
  EMPLOYEE_LOAN_DISBURSEMENT = 'employee_loan_disbursement',
}

export enum PaymentVerificationRefType {
  PURCHASE_ORDER = 'purchase_order',
  PAYROLL_RUN = 'payroll_run',
  PETTY_CASH = 'petty_cash',
  MAINTENANCE_JOB = 'maintenance_job',
  SALE_PAYMENT = 'sale_payment',
  ONLINE_ORDER = 'online_order',
  INCENTIVE = 'incentive',
  THR = 'thr',
  OTHER = 'other',
}

export enum PayeeType {
  SUPPLIER = 'supplier',
  EMPLOYEE = 'employee',
  PLATFORM = 'platform',
  OTHER = 'other',
}

// ── §2.9 Devices, topology, sync ───────────────────────────────────────────────

/** Adapted from AIRE for Mimi (D-13). */
export enum DeviceCategory {
  TABLET = 'tablet',
  POS_TERMINAL = 'pos_terminal',
  PRINTER = 'printer',
  LAPTOP = 'laptop',
  ROUTER = 'router',
  BRANCH_NODE = 'branch_node',
  OTHER = 'other',
}

export enum DeviceStatus {
  ONLINE = 'online',
  STALE = 'stale',
  OFFLINE = 'offline',
  UNPAIRED = 'unpaired',
  RETIRED = 'retired',
}

export enum DeviceEventType {
  PAIRED = 'paired',
  UNPAIRED = 'unpaired',
  ONLINE = 'online',
  OFFLINE = 'offline',
  STALE = 'stale',
  VERSION_CHANGED = 'version_changed',
  QUEUE_ALERT = 'queue_alert',
  CLOCK_SKEW = 'clock_skew',
  OUTLET_OFFLINE = 'outlet_offline',
  OUTLET_ONLINE = 'outlet_online',
}

export enum DiscoverySource {
  MDNS = 'mdns',
  SSDP = 'ssdp',
  ONVIF = 'onvif',
  TCP_PROBE = 'tcp_probe',
}

export enum PairingTargetType {
  DEVICE = 'device',
  NODE = 'node',
}

/** = `origin_tier` on the sync event envelope. */
export enum SyncOriginType {
  DEVICE = 'device',
  NODE = 'node',
  CLOUD = 'cloud',
}

/** Cloud bookkeeping (SYNC-PROTOCOL §4.4/§5.1). */
export enum SyncApplyStatus {
  PENDING = 'pending',
  APPLIED = 'applied',
  QUARANTINED = 'quarantined',
  SUPERSEDED = 'superseded',
  PENDING_DEPENDENCY = 'pending_dependency',
}

/** Permanent reject codes (SYNC-PROTOCOL §4.4). Transient rejects (`retry_later`, `gap_wait`) are not enum-worthy — they always resend. */
export enum SyncRejectCode {
  AUTHORITY_VIOLATION = 'authority_violation',
  MALFORMED = 'malformed',
  SEQ_CONFLICT = 'seq_conflict',
  PAYLOAD_VERSION_UNSUPPORTED = 'payload_version_unsupported',
}

export enum SyncBatchStatus {
  RECEIVED = 'received',
  APPLIED = 'applied',
  PARTIAL = 'partial',
  FAILED = 'failed',
}

/** SYNC-PROTOCOL §5.2 C1..C9. */
export enum SyncConflictKind {
  DOUBLE_COUNT = 'double_count',
  DUPLICATE_RECEIPT = 'duplicate_receipt',
  DECISION_RACE = 'decision_race',
  ATTENDANCE_OVERLAP = 'attendance_overlap',
  NEGATIVE_BALANCE = 'negative_balance',
  DUPLICATE_INBOUND = 'duplicate_inbound',
  OFFLINE_AUTH = 'offline_auth',
  DUPLICATE_PLATFORM_ORDER = 'duplicate_platform_order',
  POISON = 'poison',
}

export enum SyncQueue {
  CONFLICT = 'conflict',
  EXCEPTION = 'exception',
  FINANCE = 'finance',
  HR = 'hr',
}

/**
 * Values are the EXACT table names of BUILD-PLAN §4.1 that travel the wire per
 * SYNC-PROTOCOL §3.3 (classes M/F/B + the special cases listed there). Classes
 * D/X/T and embedded child tables are deliberately NOT entities — see the
 * comment block below and `@mimi/sync-protocol`'s authority matrix, which is
 * the executable form of the same table.
 */
export enum SyncEntity {
  // block 001–009
  LOCATIONS = 'locations',
  STORAGE_AREAS = 'storage_areas',
  USERS = 'users',
  ROLES = 'roles',
  PERMISSIONS = 'permissions',
  ROLE_PERMISSIONS = 'role_permissions',
  USER_LOCATIONS = 'user_locations',
  NOTIFICATIONS = 'notifications',
  SETTINGS = 'settings',
  // block 010–019
  ITEM_CATEGORIES = 'item_categories',
  UNITS = 'units',
  UNIT_CONVERSIONS = 'unit_conversions',
  ITEMS = 'items',
  PRODUCTS = 'products',
  RECIPES = 'recipes',
  // block 020–029
  MIN_STOCK_RULES = 'min_stock_rules',
  STOCK_OPNAME = 'stock_opname',
  STOCK_ADJUSTMENTS = 'stock_adjustments',
  // block 030–039
  REPLENISHMENT_REQUESTS = 'replenishment_requests',
  SURAT_JALAN = 'surat_jalan',
  SJ_DROPS = 'sj_drops',
  SJ_TEMPERATURE_LOGS = 'sj_temperature_logs',
  SJ_SEALS = 'sj_seals',
  DRIVERS = 'drivers',
  VEHICLES = 'vehicles',
  GOODS_RECEIPTS = 'goods_receipts',
  SHIPMENT_TYPES = 'shipment_types',
  // block 040–049
  PETTY_CASH = 'petty_cash',
  // block 050–059
  POS_SHIFTS = 'pos_shifts',
  SALES = 'sales',
  VOID_REFUNDS = 'void_refunds',
  ONLINE_ORDERS = 'online_orders',
  // block 060–069
  EMPLOYEES = 'employees',
  WORK_SHIFTS = 'work_shifts',
  SHIFT_ASSIGNMENTS = 'shift_assignments',
  ATTENDANCE = 'attendance',
  LEAVE_REQUESTS = 'leave_requests',
  // block 070–079
  ASSETS = 'assets',
  MAINTENANCE_SCHEDULES = 'maintenance_schedules',
  MAINTENANCE_JOBS = 'maintenance_jobs',
  SERVICE_HISTORY = 'service_history',
  // block 080–089
  WASTE_RECORDS = 'waste_records',
  RETURNS = 'returns',
  // block 090–099
  PAYMENT_VERIFICATIONS = 'payment_verifications',
  // block 110–119
  DEVICES = 'devices',
  BRANCH_NODES = 'branch_nodes',
  DEVICE_EVENTS = 'device_events',
  DISCOVERED_DEVICES = 'discovered_devices',
  // block 120–129
  OFFLINE_AUTHORIZATIONS = 'offline_authorizations',
}
// NOT SyncEntity (deliberately): stock_balances/stock_movements/journal_* (class D — derived, never on the wire),
// suppliers/supplier_*/purchase_*/po_*/payroll_*/employments/employee_loans/salary_components/sessions/audit_log/
// cash_variance_proposals/chart_of_accounts/fiscal_periods/posting_rules/stock_reconciliations/pairing_tokens/
// bpjs_configs/pph21_*/employee_tax_profiles/sync_* (class X — cloud-only), device_heartbeats (class T — lossy
// telemetry channel, not events), and all embedded child tables (recipe_lines, *_lines, sale_payments — they
// ride inside their parent's payload).

/** D-03. */
export enum NotificationChannel {
  IN_APP = 'in_app',
  EMAIL = 'email',
  WHATSAPP = 'whatsapp',
}

export enum OutboxStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

export enum ReconciliationTier {
  DEVICE = 'device',
  NODE = 'node',
  CLOUD = 'cloud',
}

/** Three-valued + pending (SYNC-PROTOCOL §7.4). */
export enum OfflineAuthOutcome {
  PENDING_VERIFICATION = 'pending_verification',
  VERIFIED = 'verified',
  FAILED = 'failed',
  UNPROVABLE = 'unprovable',
}

/** Finance decision on an unprovable/failed offline authorization (§7.5). */
export enum OfflineAuthVerdict {
  UPHELD = 'upheld',
  REJECTED = 'rejected',
}
