/** Request DTO for `POST /api/documents/invoice/manual` — see `resolvers/invoice.resolver.ts`'s header for why this is the one invoice source with a request body instead of an id. */
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Same money/qty wire-string patterns `modules/product/dto/product.dto.ts` already uses (D-10: decimal strings, never floats). */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const QTY_RE = /^\d+(\.\d{1,3})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ManualInvoiceLineDto {
  @IsString()
  @MaxLength(50)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @Matches(QTY_RE)
  qty!: string;

  @IsString()
  @MaxLength(20)
  uom!: string;

  @Matches(MONEY_RE)
  unitPrice!: string;

  @IsOptional()
  @Matches(MONEY_RE)
  discount?: string;
}

export class PostManualInvoiceDto {
  @IsString()
  @MaxLength(30)
  invoiceNumber!: string;

  @Matches(ISO_DATE_RE)
  invoiceDate!: string;

  @IsOptional()
  @Matches(ISO_DATE_RE)
  dueDate?: string;

  @IsString()
  @MaxLength(255)
  partyName!: string;

  @IsOptional()
  @IsString()
  partyAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  partyPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  locationName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  issuedBy?: string;

  @IsOptional()
  @IsIn(['cash', 'qris', 'bank_transfer'])
  paymentMethod?: 'cash' | 'qris' | 'bank_transfer';

  @IsOptional()
  @IsIn(['pending', 'verified', 'paid'])
  paymentStatus?: 'pending' | 'verified' | 'paid';

  @IsOptional()
  @Matches(MONEY_RE)
  paidAmount?: string;

  @IsOptional()
  @IsString()
  terms?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ManualInvoiceLineDto)
  lines!: ManualInvoiceLineDto[];
}
