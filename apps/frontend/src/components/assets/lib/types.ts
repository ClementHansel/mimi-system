/**
 * Wire shapes for F09 `assets` — transcribed verbatim from CONTRACTS.md
 * §4.16 (asset register / maintenance schedules / jobs / service history).
 * Kept local to `components/assets` (not `lib/shared-types`, which is
 * W1-E's frozen seam), same convention every other Wave 4 surface uses.
 */
import type { Money, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

export type AssetCategory =
  'machine' | 'vehicle' | 'equipment' | 'electronics' | 'furniture' | 'other';
export type AssetCondition = 'good' | 'fair' | 'poor';
export type AssetStatus = 'active' | 'in_maintenance' | 'retired' | 'lost';
export type MaintenanceJobStatus =
  'scheduled' | 'due' | 'in_progress' | 'done' | 'verified' | 'skipped';
export type MaintenanceJobType = 'scheduled' | 'corrective';

export interface Schedule {
  id: UUID;
  name: string;
  intervalType: 'days' | 'months';
  intervalValue: number;
  lastDoneAt: ISODate | null;
  nextDueAt: ISODate;
  reminderDaysBefore: number;
  isActive: boolean;
}

export interface Job {
  id: UUID;
  jobNumber: string;
  assetId?: UUID;
  assetName: string;
  type: MaintenanceJobType;
  status: MaintenanceJobStatus;
  dueDate: ISODate | null;
  assignedToName: string | null;
  completedAt: ISODateTime | null;
  cost: Money | null;
  proofUrls: string[];
}

export interface Asset {
  id: UUID;
  assetNumber: string;
  name: string;
  category: AssetCategory;
  locationName: string;
  locationId?: UUID;
  serialNumber: string | null;
  brand: string | null;
  model: string | null;
  purchaseDate: ISODate | null;
  purchasePrice?: Money;
  condition: AssetCondition;
  status: AssetStatus;
  assignedToName: string | null;
  photoUrl: string | null;
}

export interface AssetDetail extends Asset {
  schedules: Schedule[];
  openJobs: Job[];
}

export interface DueItem {
  jobId: UUID | null;
  scheduleId: UUID;
  assetId: UUID;
  assetName: string;
  locationName: string;
  name: string;
  dueDate: ISODate;
  overdue: boolean;
}

export interface ServiceHistoryRow {
  serviceDate: ISODate;
  description: string;
  vendor: string | null;
  cost: Money;
  conditionAfter: AssetCondition;
  odometerKm: number | null;
  recordedBy: string;
  proofUrls: string[];
}

export interface LocationOption {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  city: string;
}
