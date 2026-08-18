/**
 * The public API for Wave 4's POS (F02) and driver (F13) surfaces — the
 * "clean API for Wave 4" the brief asks for. Wave 4 code should never reach
 * past this module into `store/`, `sync/`, `stock/`, or `credentials/`
 * directly; everything it needs to capture a fact, read the local stock
 * view, or gate an offline approval is exported here.
 */
import { SyncEntity, SyncOriginType } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';
import type { SyncPayloadMeta, RecipeLineInput, SaleLineInput } from '@mimi/sync-protocol';
import type { LocalDatabase } from '../store/local-database';
import type { SyncTransport } from '../transport/types';
import type { UpstreamCandidate } from '../upstream/upstream-selector';
import { SyncEngine, type ConnectivityReporter } from '../sync/sync-engine';
import { commitFact, getOutboxDepth, type CommitFactResult } from '../idempotent-commit';
import { ensureDeviceIdentity, applyRegistration, loadDeviceIdentity } from '../identity';
import {
  getAllBalances,
  getBalance,
  recordSaleWithinTx,
  type StockKey,
  type ProjectedBalance,
} from '../stock/stock-cache';
import {
  authorizeOffline,
  cacheCredential,
  listCachedCredentials,
  type AuthorizeOfflineInput,
  type AuthorizeOfflineOutcome,
  type CachedCredentialSummary,
  type OfflineCredentialRes,
} from '../credentials/offline-credentials';
import { hashWasmPinVerifier, type PinVerifier } from '../credentials/pin-verifier';
import { noopSignatureVerifier, type SignatureVerifier } from '../credentials/signature-verifier';
import { captureAttachment, type AttachmentRef } from '../attachments/attachment-store';

export interface LocalRuntimeConfig {
  db: LocalDatabase;
  transport: SyncTransport;
  candidates: UpstreamCandidate[];
  connectivity: ConnectivityReporter;
  pinVerifier?: PinVerifier;
  /** Defaults to `noopSignatureVerifier` — the v1-unsigned-token decision (see `credentials/signature-verifier.ts`). Inject a real one here once it exists; no other call site changes. */
  signatureVerifier?: SignatureVerifier;
  /** Passed straight to `SyncEngine` — see `SyncEngineOptions.hasDeviceCredential`. */
  hasDeviceCredential?: () => boolean;
}

export interface ActorMeta {
  actorUserId: UUID;
  actorRole: string;
  appVersion: string;
  deviceLabel?: string;
}

function toPayloadMeta(actor: ActorMeta): Omit<SyncPayloadMeta, 'clockOffsetMs' | 'rawDeviceTime'> {
  return {
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    appVersion: actor.appVersion,
    deviceLabel: actor.deviceLabel,
  };
}

export class LocalRuntime {
  readonly db: LocalDatabase;
  private readonly engine: SyncEngine;
  private readonly pinVerifier: PinVerifier;
  private readonly signatureVerifier: SignatureVerifier;

  constructor(config: LocalRuntimeConfig) {
    this.db = config.db;
    this.pinVerifier = config.pinVerifier ?? hashWasmPinVerifier;
    this.signatureVerifier = config.signatureVerifier ?? noopSignatureVerifier;
    this.engine = new SyncEngine({
      db: config.db,
      transport: config.transport,
      candidates: config.candidates,
      connectivity: config.connectivity,
      hasDeviceCredential: config.hasDeviceCredential,
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await ensureDeviceIdentity(this.db);
  }

  async start(): Promise<void> {
    await this.engine.start();
  }

  stop(): void {
    this.engine.stop();
  }

  async syncNow() {
    return this.engine.syncNow();
  }

  /**
   * User-initiated "Coba Sinkron"/retry affordance: forces one fresh
   * upstream probe (bypassing the idle timer) and reports the resulting tier
   * plus whether any upstream was found — WITHOUT restarting the engine.
   * Callers that also want the sync outcome should follow a truthy
   * `hasUpstream` with `syncNow()`; skip that call when `hasUpstream` is
   * `false` rather than attempting a sync against nothing.
   */
  async recheckConnectivity() {
    return this.engine.recheckConnectivity();
  }

  setUpstreamCandidates(candidates: UpstreamCandidate[]): void {
    this.engine.setCandidates(candidates);
  }

  getUpstreamState() {
    return this.engine.getUpstreamState();
  }

  async completeRegistration(reg: Parameters<typeof applyRegistration>[1]) {
    return applyRegistration(this.db, reg);
  }

  async getIdentity() {
    return loadDeviceIdentity(this.db);
  }

  // ── generic fact capture (every entity not given a named helper below) ───

  /**
   * The general-purpose entry point: mints/reuses an idempotent event for
   * `(entity, op, entityId)` per §2.2. `entityId` MUST be minted by the
   * caller at DRAFT time (when the form/screen opens, not when the user taps
   * submit) and reused on every retry of the SAME action — that binding is
   * what makes double-tap submission safe (§2.2 rule 3, T-10).
   */
  async enqueueFact<TData>(args: {
    entity: string;
    op: string;
    entityId: UUID;
    data: TData;
    actor: ActorMeta;
    authorization?: SyncPayloadMeta['authorization'];
  }): Promise<CommitFactResult<TData>> {
    return commitFact<TData>(this.db, {
      entity: args.entity,
      op: args.op,
      entityId: args.entityId,
      data: args.data,
      meta: { ...toPayloadMeta(args.actor), authorization: args.authorization },
    });
  }

  // ── POS (F02) ──────────────────────────────────────────────────────────────

  async commitSale(args: {
    saleId: UUID;
    data: unknown;
    actor: ActorMeta;
    stockEffect?: {
      saleLines: readonly SaleLineInput[];
      recipesByProduct: ReadonlyMap<UUID, readonly RecipeLineInput[]>;
      target: { locationId: UUID; storageAreaId: UUID };
    };
  }): Promise<CommitFactResult> {
    return commitFact(
      this.db,
      {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: args.saleId,
        data: args.data,
        meta: toPayloadMeta(args.actor),
        projectWithin: args.stockEffect
          ? async (tx, envelope) => {
              await recordSaleWithinTx(tx, {
                saleEventId: envelope.eventId,
                saleLines: args.stockEffect!.saleLines,
                recipesByProduct: args.stockEffect!.recipesByProduct,
                target: args.stockEffect!.target,
                occurredAt: envelope.occurredAt,
              });
            }
          : undefined,
      },
      ['movements'],
    );
  }

  async commitShiftOpened(shiftId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.POS_SHIFTS,
      op: 'opened',
      entityId: shiftId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitShiftClosed(shiftId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.POS_SHIFTS,
      op: 'closed',
      entityId: shiftId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  /** §7 offline-provisional void/refund approval — gates on the cached credential + PIN, then commits `approved_offline` with the binding evidence attached. */
  async commitVoidApprovedOffline(args: {
    voidRefundId: UUID;
    credentialId: UUID;
    pin: string;
    amountIdr: Money | null;
    selfieRef?: AttachmentRef;
    occurredAt: string;
    actor: ActorMeta;
  }): Promise<{ authorization: AuthorizeOfflineOutcome } & Partial<{ commit: CommitFactResult }>> {
    const authInput: AuthorizeOfflineInput = {
      credentialId: args.credentialId,
      pin: args.pin,
      eventId: args.voidRefundId, // pre-bound per §2.2 rule 3; the real eventId is minted at commit but the binding is over the same logical action
      entity: SyncEntity.VOID_REFUNDS,
      entityId: args.voidRefundId,
      op: 'approved_offline',
      amountIdr: args.amountIdr,
      occurredAt: args.occurredAt,
      selfieRef: args.selfieRef,
      scopeKey: 'void_refund.approve',
    };
    const outcome = await authorizeOffline(this.db, authInput, this.pinVerifier);
    if (!outcome.ok) return { authorization: outcome };

    const commit = await commitFact(this.db, {
      entity: SyncEntity.VOID_REFUNDS,
      op: 'approved_offline',
      entityId: args.voidRefundId,
      data: { amountIdr: args.amountIdr },
      meta: { ...toPayloadMeta(args.actor), authorization: outcome.meta },
    });
    return { authorization: outcome, commit };
  }

  // ── HR / attendance (F11) ──────────────────────────────────────────────────

  async commitAttendanceCheckIn(attendanceId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.ATTENDANCE,
      op: 'checked_in',
      entityId: attendanceId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitAttendanceCheckOut(attendanceId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.ATTENDANCE,
      op: 'checked_out',
      entityId: attendanceId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  // ── Driver (F13) ────────────────────────────────────────────────────────────

  async commitDropDeparted(dropId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.SJ_DROPS,
      op: 'departed',
      entityId: dropId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitDropArrived(dropId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.SJ_DROPS,
      op: 'arrived',
      entityId: dropId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitDropReceived(dropId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.SJ_DROPS,
      op: 'received',
      entityId: dropId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitTempLog(logId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.SJ_TEMPERATURE_LOGS,
      op: 'logged',
      entityId: logId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  // ── Stock opname (F0x, D-16 territory) — class B, device-originable per authority-matrix.ts ──

  async commitOpnameOpened(opnameId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.STOCK_OPNAME,
      op: 'opened',
      entityId: opnameId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  /**
   * One opname is counted area-by-area — `stock_opname_lines` embeds per
   * area, the same parent/child shape `sj_drops`/`sj_lines` uses — but
   * `commitFact`'s dedupe key is `(entity, entityId, op)` (§2.2 rule 3), and
   * every `area_counted` fact for one opname shares that SAME op. Passing
   * the opname's own id as `entityId` here would make counting a SECOND
   * area collide with the FIRST area's already-queued row and silently
   * return it unchanged — the double-tap guard firing on the wrong action,
   * dropping a whole area's counts with no error. `areaCountId` is
   * therefore its own draft-time id, minted once per (opname, storage area)
   * when that area's count screen opens — exactly the discipline
   * `commitTempLog`'s per-log id already uses for the same reason. It is
   * NOT a wire payload field; `data.opnameId`/`data.storageAreaId` are what
   * correlate the fact back to its parent document once it lands.
   */
  async commitOpnameAreaCounted(areaCountId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.STOCK_OPNAME,
      op: 'area_counted',
      entityId: areaCountId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitOpnameSubmitted(opnameId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.STOCK_OPNAME,
      op: 'submitted',
      entityId: opnameId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitOpnameCancelled(opnameId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.STOCK_OPNAME,
      op: 'cancelled',
      entityId: opnameId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  // ── Replenishment requests (block 030-039) — class B, device-originable per authority-matrix.ts ──

  async commitReplenishmentSubmitted(requestId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      op: 'submitted',
      entityId: requestId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  async commitReplenishmentCancelled(requestId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      op: 'cancelled',
      entityId: requestId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  /**
   * The outlet supervisor's PLAIN approval — made from a device with a live
   * authenticated session, no offline credential involved. Distinct from
   * `commitReplenishmentSupervisorApprovedOffline` below (the §7/D-17
   * credential+PIN provisional path for when the approving device has no
   * live session): both are `pushOps` per the authority matrix, but only
   * the offline variant carries `meta.authorization`. The warehouse/manager
   * step (`warehouse_approved`) is neither of these — it stays cloud-only.
   */
  async commitReplenishmentSupervisorApproved(requestId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      op: 'supervisor_approved',
      entityId: requestId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  /**
   * §7 offline-provisional outlet-supervisor approval — `replenishment.supervisor_approve`
   * is one of exactly three scopes on §7.6's closed list (the other two are
   * `void_refund.approve` and `waste.approve`). Gates on the cached
   * credential + PIN, same shape as `commitVoidApprovedOffline`.
   */
  async commitReplenishmentSupervisorApprovedOffline(args: {
    requestId: UUID;
    credentialId: UUID;
    pin: string;
    amendments?: readonly { lineId: UUID; qtyApproved: Qty; reason: string }[];
    selfieRef?: AttachmentRef;
    occurredAt: string;
    actor: ActorMeta;
  }): Promise<{ authorization: AuthorizeOfflineOutcome } & Partial<{ commit: CommitFactResult }>> {
    const authInput: AuthorizeOfflineInput = {
      credentialId: args.credentialId,
      pin: args.pin,
      eventId: args.requestId, // pre-bound per §2.2 rule 3; the real eventId is minted at commit but the binding is over the same logical action
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      entityId: args.requestId,
      op: 'supervisor_approved_offline',
      amountIdr: null, // this decision carries no IDR amount of its own (registry: `{ id, amendments }`)
      occurredAt: args.occurredAt,
      selfieRef: args.selfieRef,
      scopeKey: 'replenishment.supervisor_approve',
    };
    const outcome = await authorizeOffline(this.db, authInput, this.pinVerifier);
    if (!outcome.ok) return { authorization: outcome };

    const commit = await commitFact(this.db, {
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      op: 'supervisor_approved_offline',
      entityId: args.requestId,
      data: { id: args.requestId, amendments: args.amendments },
      meta: { ...toPayloadMeta(args.actor), authorization: outcome.meta },
    });
    return { authorization: outcome, commit };
  }

  async commitReplenishmentSupervisorRejected(requestId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.REPLENISHMENT_REQUESTS,
      op: 'supervisor_rejected',
      entityId: requestId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  // ── Petty cash (block 040-049) — class B, device-originable per authority-matrix.ts ──

  /**
   * `data` carries both wajib-foto refs (`paymentProofAttachmentId` and
   * `goodsPhotoAttachmentId` per the registry's `petty_cash.recorded`
   * schema) — route both blobs through `captureEvidence` first so the
   * canonical `attachmentId` (not a freshly minted one) ends up in each
   * field, same "two identities, one row" correlation `commitDropReceived`
   * relies on for its photo/signature pair.
   */
  async commitPettyCashRecorded(pettyCashId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.PETTY_CASH,
      op: 'recorded',
      entityId: pettyCashId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  // ── Waste records (block 080-089) — class B, device-originable per authority-matrix.ts ──

  async commitWasteReported(batchId: UUID, data: unknown, actor: ActorMeta) {
    return commitFact(this.db, {
      entity: SyncEntity.WASTE_RECORDS,
      op: 'reported',
      entityId: batchId,
      data,
      meta: toPayloadMeta(actor),
    });
  }

  /**
   * §7 offline-provisional outlet-supervisor waste approval —
   * `waste.approve` is the third of §7.6's closed-list scopes (alongside
   * `void_refund.approve` and `replenishment.supervisor_approve`). Same
   * gated shape as `commitVoidApprovedOffline`. The gudang (Kepala Gudang)
   * step — `approved`/`rejected` — is deliberately NOT this: it stays
   * cloud-only and has no device commit helper.
   */
  async commitWasteApprovedOffline(args: {
    batchId: UUID;
    credentialId: UUID;
    pin: string;
    note?: string;
    selfieRef?: AttachmentRef;
    occurredAt: string;
    actor: ActorMeta;
  }): Promise<{ authorization: AuthorizeOfflineOutcome } & Partial<{ commit: CommitFactResult }>> {
    const authInput: AuthorizeOfflineInput = {
      credentialId: args.credentialId,
      pin: args.pin,
      eventId: args.batchId, // pre-bound per §2.2 rule 3, same idiom as commitVoidApprovedOffline
      entity: SyncEntity.WASTE_RECORDS,
      entityId: args.batchId,
      op: 'approved_offline',
      amountIdr: null, // registry: `waste_records.approved_offline` is `noteOptional()` — no IDR amount
      occurredAt: args.occurredAt,
      selfieRef: args.selfieRef,
      scopeKey: 'waste.approve',
    };
    const outcome = await authorizeOffline(this.db, authInput, this.pinVerifier);
    if (!outcome.ok) return { authorization: outcome };

    const commit = await commitFact(this.db, {
      entity: SyncEntity.WASTE_RECORDS,
      op: 'approved_offline',
      entityId: args.batchId,
      data: { note: args.note },
      meta: { ...toPayloadMeta(args.actor), authorization: outcome.meta },
    });
    return { authorization: outcome, commit };
  }

  // ── evidence capture (§4.7) ──────────────────────────────────────────────

  async captureEvidence(blob: Blob, mime: string, kind: string): Promise<AttachmentRef> {
    return captureAttachment(this.db, blob, mime, kind);
  }

  // ── offline credentials (§7.2) ─────────────────────────────────────────────

  async cacheOfflineCredential(res: OfflineCredentialRes) {
    return cacheCredential(this.db, res, this.signatureVerifier);
  }

  /**
   * Every offline credential cached on this device, display-safe (§7.2).
   * The one place Wave 4 (POS void/refund approval, outlet waste approval)
   * should discover a `credentialId` to pass into
   * `commitVoidApprovedOffline` — never `this.db.store('credentials')`
   * directly, which reaches past this class's own encapsulation.
   */
  async listCachedCredentials(): Promise<CachedCredentialSummary[]> {
    return listCachedCredentials(this.db);
  }

  // ── stock view (D-16, §8 row 20 — always labeled "per data lokal") ────────

  async getStockBalance(key: StockKey) {
    return getBalance(this.db, key);
  }

  async getAllStockBalances(): Promise<Map<string, ProjectedBalance>> {
    return getAllBalances(this.db);
  }

  // ── telemetry convenience ──────────────────────────────────────────────────

  async getOutboxDepth(): Promise<number> {
    return getOutboxDepth(this.db);
  }
}

export function createLocalRuntime(config: LocalRuntimeConfig): LocalRuntime {
  return new LocalRuntime(config);
}

export { SyncOriginType };
