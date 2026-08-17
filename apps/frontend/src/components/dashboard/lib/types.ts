/**
 * Wire shapes for M18 `dashboard` (CONTRACTS.md §4.18). These are transcribed
 * verbatim from `apps/backend/src/modules/dashboard/**\/*.service.ts` (not
 * re-exported from `@mimi/shared` — the dashboard module keeps its response
 * interfaces local, same as every other backend module's service-level DTOs)
 * so this stays the one seam to update if the backend shape ever moves.
 *
 * Money/Qty fields are decimal STRINGS on the wire (CONTRACTS §0) — never
 * typed as `number` here. `vs.revenuePct`/`attendanceRate` are backend-computed
 * DISPLAY percentages (bare `string`, not `Money`), not ledger amounts.
 */
import type { ISODate, Money, Qty, UUID } from '@/lib/shared-types';

export interface OverviewResponse {
  revenue: Money;
  revenueOnline: Money;
  profitEstimate: Money;
  txCount: number;
  avgTicket: Money;
  activeOutlets: number;
  vs: { revenuePct: string; txPct: string };
}

export interface OutletTile {
  locationId: UUID;
  name: string;
  city: string;
  revenue: Money;
  txCount: number;
  onlineNet: Money;
  openShifts: number;
  lowStockCount: number;
  offlineDevices: number;
  syncQueueDepth: number;
}

export interface OutletDrilldown extends OutletTile {
  hourlyTrend: { hour: number; revenue: Money }[];
  topProducts: { productId: UUID; name: string; qty: Qty; revenue: Money }[];
  staffOnShift: { employeeId: UUID; name: string; position: string }[];
}

export interface TopProductRow {
  productId: UUID;
  name: string;
  qty: Qty;
  revenue: Money;
}

export interface StaffKpiRow {
  employeeId: UUID;
  name: string;
  role: string;
  salesCount: number;
  salesAmount: Money;
  attendanceRate: string;
  lateCount: number;
}

export type TrendMetric = 'revenue' | 'tx' | 'usage';
export type TrendGranularity = 'daily' | 'weekly';

export interface TrendPoint {
  t: ISODate;
  value: string;
}

export interface OpsStatusResponse {
  lowStockOutlets: number;
  sjInTransit: number;
  pendingApprovals: number;
  pendingPayments: number;
  offlineOutlets: number;
  openConflicts: number;
  coldChainBreaches24h: number;
  maintenanceDue: number;
}

export interface RefreshResult {
  view: string;
  ok: boolean;
  error?: string;
}

/** Legible scope of the figures currently on screen — the one thing FR requires never be ambiguous. */
export type DashboardScope = 'company' | 'outlet';
