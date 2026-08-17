import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ShipmentType, SuratJalanStatus } from '@mimi/shared';

/** `NUMERIC(14,3)` decimal-string pattern (D-10) — sign, integer, optional up to 3dp. */
const QTY_RE = /^-?\d+(\.\d{1,3})?$/;
/** `NUMERIC(4,1)` decimal-string pattern (D-10). */
const TEMP_RE = /^-?\d+(\.\d{1})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ListSuratJalanQueryDto {
  @IsOptional()
  @IsIn(Object.values(SuratJalanStatus))
  status?: SuratJalanStatus;

  @IsOptional()
  @Matches(ISO_DATE_RE)
  date?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}

export class SuratJalanLineDto {
  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_RE, { message: 'qty must be a decimal string with up to 3 fractional digits' })
  qty!: string;

  @IsUUID()
  unitId!: string;

  @IsOptional()
  @IsUUID()
  requestLineId?: string;
}

export class SuratJalanDropDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  replenishmentRequestId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SuratJalanLineDto)
  lines!: SuratJalanLineDto[];
}

/** `POST /api/delivery/surat-jalan` body (CONTRACTS.md §4.10). */
export class CreateSuratJalanDto {
  @IsIn(Object.values(ShipmentType))
  shipmentType!: ShipmentType;

  @IsUUID()
  driverId!: string;

  @IsUUID()
  vehicleId!: string;

  @Matches(ISO_DATE_RE)
  plannedDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SuratJalanDropDto)
  drops!: SuratJalanDropDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

/** `PATCH /api/delivery/surat-jalan/:id` body — draft/ready only (FR-LOG-05). */
export class UpdateSuratJalanDto {
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @Matches(ISO_DATE_RE)
  plannedDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SuratJalanDropDto)
  drops?: SuratJalanDropDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

export class SealNumberDto {
  @IsString()
  @MaxLength(50)
  sealNumber!: string;
}

/** `POST /api/delivery/surat-jalan/:id/load` body. */
export class LoadSuratJalanDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SealNumberDto)
  seals!: SealNumberDto[];

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempC?: string;
}

export class ReasonDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
