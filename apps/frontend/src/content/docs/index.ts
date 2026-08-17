import type { DocManual } from './types';
import { kasirManual } from './kasir';
import { supervisorOutletManual } from './supervisor-outlet';
import { kepalaGudangManual } from './kepala-gudang';
import { driverManual } from './driver';
import { keuanganManual } from './keuangan';
import { pemilikManajerManual } from './pemilik-manajer';

export type { DocManual, DocSection, DocBlock } from './types';

/** Every published manual, in `order`. Add a new manual by pushing it here. */
export const MANUALS: readonly DocManual[] = [
  kasirManual,
  supervisorOutletManual,
  kepalaGudangManual,
  driverManual,
  keuanganManual,
  pemilikManajerManual,
].sort((a, b) => a.order - b.order);

export function getManual(slug: string): DocManual | undefined {
  return MANUALS.find((m) => m.slug === slug);
}

/** Table of contents entries derived from a manual's own sections — no separate authoring needed. */
export function tocFor(manual: DocManual): { id: string; text: string; level: 2 | 3 }[] {
  return manual.sections.map((s) => ({ id: s.id, text: s.heading, level: s.level ?? 2 }));
}
