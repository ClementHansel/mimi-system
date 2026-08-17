import { IsInt, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

/** `POST /api/attachments/presign` body (CONTRACTS.md §4.0). */
export class PresignDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @IsInt()
  @IsPositive()
  sizeBytes!: number;

  @IsString()
  @MaxLength(50)
  kind!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

/** `POST /api/attachments/:id/confirm` body (CONTRACTS.md §4.0). */
export class ConfirmDto {
  @IsString()
  sha256!: string;
}
