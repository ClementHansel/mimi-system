/**
 * The authority matrix — SYNC-PROTOCOL §3.3, shipped as EXECUTABLE DATA
 * (§3.4: "The cloud ingest pipeline enforces... it is not documentation").
 *
 * Covers every `SyncEntity` (the 49 wire-eligible tables, classes M/F/B) plus
 * a supplementary list of known NON-wire entities (classes D/X/T — derived,
 * cloud-only, or lossy telemetry) so `canOriginate`/`resolveDirection` can
 * correctly REJECT a push attempt against them rather than returning
 * "unknown" for something the system actually knows about and has
 * deliberately excluded from the wire. This distinction matters for the
 * enforcement rule (§3.4 step 2): "`M`/`X`/`D` entities pushed from below →
 * `authority_violation`, permanent reject."
 *
 * CONTRACT NOTE (flagged in the W1-B report): `service_history` appears in
 * CONTRACTS.md §2.9's `SyncEntity` enum (block 070-079) but SYNC-PROTOCOL
 * §3.3 group 8 classifies it as class **D** ("cloud-derived from
 * maintenance_jobs facts... no independent ops"), which by rule 1 of §3.1
 * should make it NOT a `SyncEntity` member at all. Resolved here by
 * classifying it `'D'` with `direction: 'pull'` and an empty `ops` list — it
 * may still be pulled down as a read-only cache for display (SYNC-PROTOCOL's
 * own wording), but `canOriginate` rejects every push against it, consistent
 * with its D classification.
 */
import { SyncEntity, SyncOriginType } from '@mimi/shared';

export type AuthorityClass = 'M' | 'F' | 'B' | 'D' | 'X' | 'T';
export type AuthorityDirection = 'pull' | 'push' | 'bidirectional' | 'none';
export type AuthorityPullScope = 'global' | 'own_location' | 'assigned' | 'none';

export interface EntityAuthority {
  class: AuthorityClass;
  direction: AuthorityDirection;
  pullScope: AuthorityPullScope;
  /** The full op vocabulary the cloud accepts for this entity, from BOTH directions combined; anything else -> `malformed`. */
  ops: readonly string[];
  /**
   * The subset of `ops` a device/node may legally ORIGINATE (push up).
   * Required whenever `direction === 'bidirectional'` — a class-B entity's
   * `ops` list mixes edge-pushed facts (e.g. `requested`, `approved_offline`)
   * with cloud-only decisions (e.g. `approved`, `rejected`) that a device
   * must never be treated as authorized to originate even though both
   * appear in the same entity's vocabulary. Omitted for `direction ===
   * 'push'` (every op is push-eligible by definition) and ignored for
   * `'pull'`/`'none'` (nothing is ever device-originated).
   */
  pushOps?: readonly string[];
  /** Ops normally push-only that are, by exception, allowed the other way too (e.g. `notifications.read_marked`). */
  pushExceptionOps?: readonly string[];
  /** Child entities that ride inside this entity's payload rather than traveling as their own event. */
  embedded?: readonly string[];
  note?: string;
}

function entity(
  e: Partial<EntityAuthority> & Pick<EntityAuthority, 'class' | 'direction' | 'pullScope' | 'ops'>,
): EntityAuthority {
  return e;
}

// prettier-ignore
export const AUTHORITY: Readonly<Record<string, EntityAuthority>> = {
  // ── Group 1 — Identity, org, config (block 001-009) ────────────────────────
  [SyncEntity.LOCATIONS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.STORAGE_AREAS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.USERS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['created', 'updated', 'deactivated', 'pin_rotated'] }),
  [SyncEntity.ROLES]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'] }),
  [SyncEntity.PERMISSIONS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'] }),
  [SyncEntity.ROLE_PERMISSIONS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'] }),
  [SyncEntity.USER_LOCATIONS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['assigned', 'revoked'] }),
  [SyncEntity.NOTIFICATIONS]: entity({
    class: 'F', direction: 'pull', pullScope: 'assigned', ops: ['issued', 'read'],
    pushExceptionOps: ['read_marked'], note: 'the one pull-class entity with a push exception (§3.3 group 1)',
  }),
  [SyncEntity.SETTINGS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'] }),

  // ── Group 2 — Catalog (block 010-019) ──────────────────────────────────────
  [SyncEntity.ITEM_CATEGORIES]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.UNITS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.UNIT_CONVERSIONS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.ITEMS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.PRODUCTS]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated', 'price_changed'] }),
  [SyncEntity.RECIPES]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'], embedded: ['recipe_lines'] }),

  // ── Group 3 — Stock (block 020-029; D-16 territory) ────────────────────────
  [SyncEntity.MIN_STOCK_RULES]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['updated'] }),
  [SyncEntity.STOCK_OPNAME]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['opened', 'area_counted', 'submitted', 'cancelled', 'approved', 'rejected'],
    pushOps: ['opened', 'area_counted', 'submitted', 'cancelled'],
    embedded: ['stock_opname_lines'],
    note: 'push: opened/area_counted/submitted/cancelled; pull (decision, never offline): approved/rejected',
  }),
  [SyncEntity.STOCK_ADJUSTMENTS]: entity({
    class: 'B', direction: 'pull', pullScope: 'own_location', ops: ['posted'],
    note: 'cloud-only decides; never device-born — an offline "adjustment" does not exist, only count facts',
  }),

  // ── Group 4 — Replenishment & logistics (block 030-039) ────────────────────
  [SyncEntity.REPLENISHMENT_REQUESTS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: [
      'submitted', 'cancelled', 'supervisor_approved', 'supervisor_approved_offline', 'supervisor_rejected',
      'warehouse_approved', 'warehouse_rejected', 'amended', 'fulfillment_started', 'shipped', 'completed',
    ],
    pushOps: ['submitted', 'cancelled', 'supervisor_approved', 'supervisor_approved_offline', 'supervisor_rejected'],
    embedded: ['replenishment_request_lines'],
    note: 'decision always wins over request-side edits; online decision always wins over offline-provisional (§5.3)',
  }),
  [SyncEntity.SURAT_JALAN]: entity({
    class: 'B', direction: 'pull', pullScope: 'own_location', ops: ['issued', 'updated', 'cancelled'],
    embedded: ['sj_lines'],
    note: 'cloud (warehouse) creates; SJ numbers cloud-assigned at issue — no offline numbering problem',
  }),
  [SyncEntity.SJ_DROPS]: entity({
    class: 'B', direction: 'push', pullScope: 'assigned', ops: ['departed', 'arrived', 'received'],
    note: 'push facts (driver: departed/arrived; outlet: received); the document itself travels inside surat_jalan.issued',
  }),
  [SyncEntity.SJ_TEMPERATURE_LOGS]: entity({ class: 'F', direction: 'push', pullScope: 'assigned', ops: ['logged'] }),
  [SyncEntity.SJ_SEALS]: entity({ class: 'B', direction: 'pull', pullScope: 'own_location', ops: ['applied'] }),
  [SyncEntity.DRIVERS]: entity({ class: 'M', direction: 'pull', pullScope: 'assigned', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.VEHICLES]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.GOODS_RECEIPTS]: entity({
    class: 'F', direction: 'push', pullScope: 'own_location', ops: ['recorded'], embedded: ['goods_receipt_lines'],
    note: 'supplier-direct-to-outlet receiving only; SJ receiving is sj_drops.received, PO receiving is class X',
  }),
  [SyncEntity.SHIPMENT_TYPES]: entity({ class: 'M', direction: 'pull', pullScope: 'global', ops: ['updated'] }),

  // ── Group 5 — Purchasing & petty cash (block 040-049) ──────────────────────
  [SyncEntity.PETTY_CASH]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['recorded', 'verified', 'rejected'], pushOps: ['recorded'], embedded: ['petty_cash_lines'],
    note: 'verify/reject are Finance, online-only (never offline-approvable, §7.6)',
  }),

  // ── Group 6 — POS (block 050-059) ──────────────────────────────────────────
  [SyncEntity.POS_SHIFTS]: entity({ class: 'F', direction: 'push', pullScope: 'own_location', ops: ['opened', 'closed'] }),
  [SyncEntity.SALES]: entity({
    class: 'F', direction: 'push', pullScope: 'own_location', ops: ['completed'],
    embedded: ['sale_lines', 'sale_payments'], note: 'no conflict possible — dedupe by event_id',
  }),
  [SyncEntity.VOID_REFUNDS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['requested', 'approved_offline', 'approved', 'rejected', 'executed'],
    pushOps: ['requested', 'approved_offline', 'executed'],
    note: 'D-17-eligible: approved_offline is the closed-list offline-provisional case (§7.6); a plain online approved/rejected decision is made via REST, only pulled down to devices, never itself device-pushed',
  }),
  [SyncEntity.ONLINE_ORDERS]: entity({ class: 'F', direction: 'push', pullScope: 'own_location', ops: ['recorded', 'status_updated'] }),

  // ── Group 7 — HR & payroll (block 060-069) ─────────────────────────────────
  [SyncEntity.EMPLOYEES]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['created', 'updated', 'deactivated'] }),
  [SyncEntity.WORK_SHIFTS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['updated'] }),
  [SyncEntity.SHIFT_ASSIGNMENTS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['assigned', 'changed', 'removed'] }),
  [SyncEntity.ATTENDANCE]: entity({ class: 'F', direction: 'push', pullScope: 'own_location', ops: ['checked_in', 'checked_out'] }),
  [SyncEntity.LEAVE_REQUESTS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'assigned',
    ops: ['submitted', 'cancelled', 'approved', 'rejected'], pushOps: ['submitted', 'cancelled'],
    note: 'decisions online-only',
  }),

  // ── Group 8 — Assets (block 070-079) ───────────────────────────────────────
  [SyncEntity.ASSETS]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['created', 'updated', 'retired'] }),
  [SyncEntity.MAINTENANCE_SCHEDULES]: entity({ class: 'M', direction: 'pull', pullScope: 'own_location', ops: ['updated'] }),
  [SyncEntity.MAINTENANCE_JOBS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location', ops: ['created', 'completed'], pushOps: ['completed'],
    note: 'pull: created (due job); push: completed (execution). verification is a separate online supervisor act, not a sync op',
  }),
  [SyncEntity.SERVICE_HISTORY]: entity({
    class: 'D', direction: 'pull', pullScope: 'own_location', ops: [],
    note: 'CONTRACT NOTE: class D per SYNC-PROTOCOL §3.3 group 8 (derived from maintenance_jobs); read-only cache only, canOriginate always rejects a push',
  }),

  // ── Group 9 — Waste & returns (block 080-089) ──────────────────────────────
  [SyncEntity.WASTE_RECORDS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['reported', 'approved_offline', 'approved', 'rejected'],
    pushOps: ['reported', 'approved_offline'],
    note: 'outlet-supervisor step is D-17-eligible (§7.6); gudang step is online-only',
  }),
  [SyncEntity.RETURNS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['submitted', 'shipped_back', 'approved', 'rejected', 'received_at_warehouse'],
    pushOps: ['submitted', 'shipped_back'],
    embedded: ['return_lines'], note: 'outlet leg only; the supplier leg is class X (cloud-born only)',
  }),

  // ── Group 10 — Accounting (block 090-099) ──────────────────────────────────
  [SyncEntity.PAYMENT_VERIFICATIONS]: entity({
    class: 'B', direction: 'pull', pullScope: 'own_location', ops: ['verified', 'paid', 'rejected'],
    note: 'pulled so POS/outlet can show status; never offline-decidable (§7.6)',
  }),

  // ── Group 12 — Devices & topology (block 110-119) ──────────────────────────
  [SyncEntity.DEVICES]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location',
    ops: ['registered', 'profile_updated', 'paired', 'renamed', 'retired', 'revoked'],
    pushOps: ['registered', 'profile_updated'],
    note: '`revoked` pulled to a device is a kill switch: it must stop pushing and wipe credentials',
  }),
  [SyncEntity.BRANCH_NODES]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'none',
    ops: ['registered', 'paired', 'config_updated', 'cert_rotated', 'revoked'], pushOps: ['registered'], note: 'nodes only',
  }),
  [SyncEntity.DEVICE_EVENTS]: entity({
    class: 'F', direction: 'bidirectional', pullScope: 'own_location',
    // `outlet_offline`/`outlet_online` are OUTLET-level edges, not device-level:
    // raised by the cloud's `staleness-sweep.service.ts` when every active
    // device AND the node at a location have been dark past its threshold.
    // They were emitted by that sweep but never declared here, so every firing
    // failed schema validation and was swallowed by the emit's own
    // `.catch(logger.warn)` — silently, deterministically, forever. Found by
    // the W6-06 soak spec. Pull-only, like the other cloud-born transitions.
    ops: ['storage_warning', 'storage_full', 'quarantine_added', 'clock_suspect', 'credential_denied', 'went_online', 'went_offline', 'stale', 'outlet_offline', 'outlet_online'],
    pushOps: ['storage_warning', 'storage_full', 'quarantine_added', 'clock_suspect', 'credential_denied'],
    note: 'push: origin incidents; pull: cloud-born transitions (went_online/went_offline/stale) + outlet-level edges (outlet_offline/outlet_online)',
  }),
  [SyncEntity.DISCOVERED_DEVICES]: entity({
    class: 'F', direction: 'push', pullScope: 'none', ops: ['discovered', 'updated', 'disappeared'],
    note: 'node origin only; viewed in F12 online, never pulled to a device',
  }),

  // ── Group 13 — Sync infrastructure (block 120-129) ─────────────────────────
  [SyncEntity.OFFLINE_AUTHORIZATIONS]: entity({
    class: 'B', direction: 'bidirectional', pullScope: 'own_location', ops: ['used', 'revoked'], pushOps: ['used'],
    note: 'credential material itself never travels the event stream — only usage facts and CRL revocations',
  }),

  // ── Known non-wire entities (classes D/X/T) — never accept a push, never in any pull scope ──
  stock_balances: entity({ class: 'D', direction: 'none', pullScope: 'none', ops: [], note: 'derived at every tier (D-16); NEVER SYNCED in either direction' }),
  stock_movements: entity({ class: 'D', direction: 'none', pullScope: 'none', ops: [], note: 'derived at every tier; syncing would double-apply' }),
  journal_entries: entity({ class: 'D', direction: 'none', pullScope: 'none', ops: [] }),
  journal_lines: entity({ class: 'D', direction: 'none', pullScope: 'none', ops: [] }),
  suppliers: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'FR-SUP-06 role lock; online surfaces only' }),
  supplier_items: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  supplier_price_history: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  purchase_requests: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  purchase_orders: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  po_lines: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  po_receipts: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  employments: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  employee_loans: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  salary_components: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  payroll_periods: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  payroll_runs: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  payroll_lines: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  cash_variance_proposals: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'D-19/Amendment 2; cloud-born at shift-close apply (R7), decided online only — never offline-authorizable (§7.6)' }),
  bpjs_configs: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'D-18/Amendment 1 statutory config; client-maintained via §4.15 config endpoints, online only' }),
  pph21_ter_rates: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  pph21_ptkp: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  pph21_article17_brackets: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'D-18/Amendment 1; added §1.7 block 060-069 per architect follow-up to the W1-B report finding #5' }),
  employee_tax_profiles: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'statutory config, online-only' }),
  sessions: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'auth artifact, never synced' }),
  audit_log: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'written by @Audited() at apply time; never synced down' }),
  chart_of_accounts: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  fiscal_periods: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  posting_rules: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  stock_reconciliations: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  pairing_tokens: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [], note: 'minted online, presented once; never in the event stream' }),
  sync_conflicts: entity({ class: 'X', direction: 'none', pullScope: 'none', ops: [] }),
  device_heartbeats: entity({ class: 'T', direction: 'none', pullScope: 'none', ops: [], note: 'lossy telemetry channel — not sync events, no outbox, no dedupe' }),
};

/**
 * Enforcement rule 2 (§3.4): can `tier` legally originate a push of
 * `(entity, op)`? `false` for an unknown entity (→ `malformed`), any class
 * M/X/D/T entity (→ `authority_violation`), or an op outside that entity's
 * vocabulary. The cloud tier is exempt (it is the privileged origin for
 * master-data edits and decisions — §1.5) and always returns `true` for a
 * known `(entity, op)` pair regardless of direction.
 */
export function canOriginate(tier: SyncOriginType, entityName: string, op: string): boolean {
  const meta = AUTHORITY[entityName];
  if (!meta) return false;

  const knownOp = meta.ops.includes(op) || (meta.pushExceptionOps?.includes(op) ?? false);
  if (!knownOp) return false;

  if (tier === SyncOriginType.CLOUD) return true;

  if (meta.class === 'M' || meta.class === 'X' || meta.class === 'D' || meta.class === 'T')
    return false;
  if (meta.direction === 'none') return false;
  if (meta.direction === 'pull') return meta.pushExceptionOps?.includes(op) ?? false;
  if (meta.direction === 'push') return true; // every op of a push-only entity is push-eligible by definition
  // 'bidirectional': only the explicitly-declared pushOps subset is device/node-originable —
  // the rest of `ops` are cloud-decided facts a device must never be treated as authorized to originate.
  return meta.pushOps?.includes(op) ?? false;
}

/** The declared sync direction for an entity, or `undefined` if it is not in the matrix at all. */
export function resolveDirection(entityName: string): AuthorityDirection | undefined {
  return AUTHORITY[entityName]?.direction;
}

export function resolvePullScope(entityName: string): AuthorityPullScope | undefined {
  return AUTHORITY[entityName]?.pullScope;
}

export function isKnownSyncEntity(entityName: string): entityName is SyncEntity {
  const meta = AUTHORITY[entityName];
  return meta !== undefined && meta.class !== 'X' && meta.class !== 'D' && meta.class !== 'T';
}

/** Every entity whose class is M/F/B — i.e. every real `SyncEntity` member the matrix knows about. */
export function wireEligibleEntities(): string[] {
  return Object.entries(AUTHORITY)
    .filter(([, meta]) => meta.class === 'M' || meta.class === 'F' || meta.class === 'B')
    .map(([name]) => name);
}
