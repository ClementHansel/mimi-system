/**
 * Wire shapes for F13 `driver` — transcribed verbatim from CONTRACTS.md
 * §4.10 (delivery / Surat Jalan / drops / cold chain / receiving). Kept
 * local to `components/driver` (not `lib/shared-types`, which is W1-E's
 * frozen seam), same convention `components/outlet/lib/types.ts` uses.
 *
 * Unlike `outlet`'s `SuratJalan`, this one carries `seals`/`tempLogs` — the
 * driver's `GET /delivery/my-jobs` response is the "full detail — F13
 * pre-departure cache" CONTRACTS calls out, so the whole cold-chain record
 * travels with it.
 */
import type { Qty, Temp, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

export type DropStatus = 'pending' | 'en_route' | 'arrived' | 'completed' | 'completed_discrepancy' | 'failed';
export type SealStatus = 'applied' | 'verified_intact' | 'broken' | 'replaced';
export type TempLogStage = 'load' | 'depart' | 'arrive';

export interface DropLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  storageType: 'frozen' | 'chilled' | 'dry';
  qty: Qty;
  qtyReceived: Qty | null;
  receivedStorageAreaId: UUID | null;
  discrepancyReason: string | null;
}

export interface Drop {
  id: UUID;
  dropSeq: number;
  locationId: UUID;
  locationName: string;
  city: string;
  replenishmentRequestId: UUID | null;
  status: DropStatus;
  departedAt: ISODateTime | null;
  arrivedAt: ISODateTime | null;
  receivedBy: string | null;
  receivedAt: ISODateTime | null;
  signatureUrl: string | null;
  photoUrls: string[];
  discrepancyNotes: string | null;
  lines: DropLine[];
}

export interface TempLog {
  id: UUID;
  dropId: UUID | null;
  stage: TempLogStage;
  tempC: Temp;
  isBreach: boolean;
  loggedBy: string;
  loggedAt: ISODateTime;
}

export interface Seal {
  id: UUID;
  dropId: UUID | null;
  sealNumber: string;
  status: SealStatus;
  checkedBy: string | null;
  checkedAt: ISODateTime | null;
}

export interface SuratJalan {
  id: UUID;
  sjNumber: string;
  originLocationId: UUID;
  shipmentType: 'frozen' | 'dry';
  driver: { id: UUID; name: string; phone: string | null };
  vehicle: { id: UUID; plateNumber: string; hasFreezer: boolean };
  status: string;
  plannedDate: ISODate;
  dispatchedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  drops: Drop[];
  seals: Seal[];
  tempLogs: TempLog[];
  createdBy: string;
}

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: string;
  tempMin: Temp | null;
  tempMax: Temp | null;
  sortOrder: number;
  isActive: boolean;
}
