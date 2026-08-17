/**
 * Wire shapes for F-DELIVERY `delivery` — the central-warehouse dispatcher's
 * own surface (CONTRACTS.md §4.10 M10 `delivery`).
 *
 * `SuratJalan`/`Drop`/`DropLine`/`Seal`/`TempLog` come from `@/lib/shared-types`
 * (which re-exports `@mimi/shared`, W1-E's frozen seam) — not redeclared,
 * per this ticket's explicit instruction. That also gets this surface
 * `TempLog.breachedClasses`/`ranges` for free, richer than the two
 * pre-existing local hand-rolled copies in `components/driver/lib/types.ts`
 * and `components/warehouse/lib/types.ts`.
 *
 * `Driver`/`Vehicle`/`Replenishment`/`DailyRecap` have no `@mimi/shared`
 * interface (CONTRACTS §4.9/§4.10 only tables them inline as REST
 * response shapes) — rather than hand-roll a THIRD identical copy of these
 * (driver doesn't need them; `components/warehouse/lib/types.ts` already has
 * one, transcribed from the same CONTRACTS rows this surface reads), they're
 * re-exported from there. `warehouse` isn't a protected/owned-by-another-
 * agent path for this ticket, and the shapes are byte-identical (same
 * CONTRACTS table) — importing beats a third transcription that would only
 * drift from the other two over time.
 */
export type { Driver, Vehicle, Replenishment, ReplenishmentLine, DailyRecap } from '@/components/warehouse/lib/types';
