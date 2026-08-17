import { IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { AssetCategory, AssetCondition, AssetStatus } from '@mimi/shared';

/** `POST /api/assets` — CONTRACTS.md §4.16. */
export class CreateAssetDto {
  @IsOptional()
  @IsString()
  assetNumber?: string;

  @IsString()
  name!: string;

  @IsIn(Object.values(AssetCategory))
  category!: AssetCategory;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsNumberString()
  purchasePrice?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string;

  @IsOptional()
  @IsUUID()
  photoAttachmentId?: string;
}

/** `PATCH /api/assets/:id` — partial, incl. condition/status/assignedToEmployeeId (FR-PMS-01/04). */
export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(Object.values(AssetCategory))
  category?: AssetCategory;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsNumberString()
  purchasePrice?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @IsIn(Object.values(AssetCondition))
  condition?: AssetCondition;

  @IsOptional()
  @IsIn(Object.values(AssetStatus))
  status?: AssetStatus;

  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string;

  @IsOptional()
  @IsUUID()
  photoAttachmentId?: string;
}
