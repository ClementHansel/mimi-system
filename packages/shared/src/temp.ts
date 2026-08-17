/**
 * Temperature arithmetic — NUMERIC(4,1), decimal-string wire format (D-10, CONTRACTS.md §0).
 * Cold-chain breach checks (D-14) compare a logged reading against a range
 * (`storage_areas.temp_min/max`, `shipment_types.temp_min/max`, `items.temp_min/max`)
 * — this module exists mainly for that comparison, plus the arithmetic needed
 * to keep it decimal-safe rather than float-adjacent.
 */
import type { Temp } from './types';
import {
  parseFixed,
  formatFixed,
  compareFixed,
  subFixed,
  addFixed,
  negateFixed,
  absFixed,
} from './decimal/fixed-point';

export const TEMP_SCALE = 1;

export function parseTemp(value: Temp): bigint {
  return parseFixed(value, TEMP_SCALE);
}

export function formatTemp(scaled: bigint): Temp {
  return formatFixed(scaled, TEMP_SCALE);
}

export function compareTemp(a: Temp, b: Temp): -1 | 0 | 1 {
  return compareFixed(parseTemp(a), parseTemp(b));
}

export function subTemp(a: Temp, b: Temp): Temp {
  return formatTemp(subFixed(parseTemp(a), parseTemp(b)));
}

export function addTemp(a: Temp, b: Temp): Temp {
  return formatTemp(addFixed(parseTemp(a), parseTemp(b)));
}

export function negateTemp(a: Temp): Temp {
  return formatTemp(negateFixed(parseTemp(a)));
}

export function absTemp(a: Temp): Temp {
  return formatTemp(absFixed(parseTemp(a)));
}

/**
 * True when `reading` falls outside `[min, max]` (either bound optional/null =
 * unbounded on that side). Mirrors the cold-chain breach rule used at SJ load,
 * every drop's `depart`/`arrive` stage, and storage-area putaway warnings
 * (D-14, `sj_temperature_logs.is_breach`, FR-LOG-14/15, OBJ-03).
 */
export function isTempBreach(reading: Temp, min: Temp | null, max: Temp | null): boolean {
  const r = parseTemp(reading);
  if (min != null && r < parseTemp(min)) return true;
  if (max != null && r > parseTemp(max)) return true;
  return false;
}
