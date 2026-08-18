/**
 * Cold-chain pure helpers for F13 `driver` (D-14, OBJ-03). No I/O, no React —
 * plain predicates so per-drop gating is unit-testable without a rendered
 * form.
 *
 * NO client-side breach evaluation lives here (deliberately — see the
 * removed `isFrozenBreach`/`FROZEN_TEMP_RANGE` in git history). A `frozen`
 * shipment is the cold-chain truck and carries BOTH chilled (0..5°C) and
 * frozen (-25..-15°C) goods at once (the owner's ruling: `ShipmentType`
 * stays `frozen`/`dry`, but `frozen` means "the cold-chain truck", not
 * "everything on it is frozen"); the acceptable range depends on which
 * classes are still onboard at the time of the reading — a per-class
 * evaluation only the backend can resolve (it knows the live
 * `storage_areas` ranges and which lines haven't been delivered yet). A
 * single static range here would flag every chilled reading as a breach
 * (or worse, silently pass a genuine frozen breach) — replaying that logic
 * client-side is exactly the duplicated-fraud-rule pattern this codebase
 * has already paid for. This surface only ever DISPLAYS the server's own
 * verdict (`TempLog.isBreach`, already wired through `tempLogsForDrop`
 * below) and never blocks entry of a reading, breach or not.
 */
import type { UUID } from '@/lib/shared-types';
import type { Drop, Seal, SuratJalan } from './types';

/** The seal that applies to one drop: a drop-specific seal if the SJ tracked one, otherwise the SJ-wide seal (single freezer box covering the whole route). */
export function sealForDrop(sj: SuratJalan, dropId: UUID): Seal | null {
  return (
    sj.seals.find((s) => s.dropId === dropId) ?? sj.seals.find((s) => s.dropId === null) ?? null
  );
}

/** Temp logs for one drop stage, most recent first — read-only history shown alongside the action forms. */
export function tempLogsForDrop(sj: SuratJalan, dropId: UUID): SuratJalan['tempLogs'] {
  return sj.tempLogs
    .filter((l) => l.dropId === dropId)
    .slice()
    .sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));
}

export type DropAction = 'depart' | 'arrive' | 'receive' | 'fail' | 'none';

/**
 * The per-drop gating rule (D-14's multi-drop sequence): exactly one action
 * is ever available for a given drop at a time, driven entirely by its own
 * status/timestamps — never by dropSeq order (a driver may need to skip
 * ahead if an earlier drop's outlet is unreachable, D-14's "fail" path), so
 * this never blocks drop N+1 on drop N's completion.
 */
export function nextActionForDrop(drop: Drop): DropAction {
  if (
    drop.status === 'completed' ||
    drop.status === 'completed_discrepancy' ||
    drop.status === 'failed'
  )
    return 'none';
  if (!drop.departedAt) return 'depart';
  if (!drop.arrivedAt) return 'arrive';
  return 'receive';
}
