/**
 * Defensive `payload.data` field accessors for conflict detection
 * (`conflict-detector.service.ts`) and reconciliation (`reconciliation
 * .service.ts`). Field names below are taken VERBATIM from W1-B's payload
 * schema registry (`packages/sync-protocol/src/schema/registry.ts`), which
 * landed after this file's first draft — the first draft GUESSED at field
 * names (e.g. `platformOrderId`, `countedCash`) and got two of them wrong;
 * this revision corrects those against the real registry. `validate()`/
 * `validatePayloadData()` (same package, `./schema`) is the actual
 * structural check, wired into `sync-ingest.service.ts`'s `checkAuthority`
 * — the accessors here are read-only convenience on top of already-valid
 * data, and stay defensive (never throw) purely as a second line of
 * defense against a schema/registry drift this file didn't catch.
 */
import type { Money, UUID } from '@mimi/shared';

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function obj(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

// ── C1: stock_opname.area_counted — registry: { opnameId, storageAreaId, lines: [{itemId, systemQty, countedQty, varianceReason?}] } ──
export interface AreaCountedShape {
  storageAreaId: UUID;
  lines: { itemId: UUID }[];
}
export function readAreaCounted(data: unknown): AreaCountedShape | undefined {
  const d = obj(data);
  const storageAreaId = str(d.storageAreaId);
  const linesRaw = arr(d.lines);
  if (!storageAreaId || !linesRaw) return undefined;
  const lines = linesRaw
    .map((l) => str(obj(l).itemId))
    .filter((id): id is UUID => !!id)
    .map((itemId) => ({ itemId }));
  return { storageAreaId, lines };
}

// ── C8: online_orders.recorded — registry: { ..., platform, orderRef, ... } (NOT `platformOrderId` — corrected) ──
export interface OnlineOrderShape {
  platform: string;
  orderRef: string;
}
export function readOnlineOrder(data: unknown): OnlineOrderShape | undefined {
  const d = obj(data);
  const platform = str(d.platform);
  const orderRef = str(d.orderRef);
  if (!platform || !orderRef) return undefined;
  return { platform, orderRef };
}

// ── R4: sales.completed's lines[] — registry: { productId, qty, unitPrice, discount? } ──
export interface SaleLineForVariance {
  productId: UUID;
  unitPrice: Money;
}
export function readSaleLines(data: unknown): SaleLineForVariance[] {
  const d = obj(data);
  const linesRaw = arr(d.lines) ?? [];
  return linesRaw
    .map((l) => {
      const lo = obj(l);
      const productId = str(lo.productId);
      const unitPrice = str(lo.unitPrice);
      return productId && unitPrice ? { productId, unitPrice } : undefined;
    })
    .filter((x): x is SaleLineForVariance => !!x);
}

// ── R7: pos_shifts.closed — registry: { closingCashCounted, notes?, closedAt? } (NOT `countedCash`/`declaredTotals` — corrected; there is no separate "declared" field, only the counted amount the kasir enters) ──
export interface ShiftClosedShape {
  closingCashCounted?: Money;
}
export function readShiftClosed(data: unknown): ShiftClosedShape {
  const d = obj(data);
  return { closingCashCounted: str(d.closingCashCounted) };
}
