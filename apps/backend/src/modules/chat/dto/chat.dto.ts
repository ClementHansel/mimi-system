import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** W7 chat DTOs. Lengths are bounded because two of these are reachable from outside the building. */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  // WhatsApp's own limit is ~4096; anything longer would be silently truncated
  // by the gateway, so it is rejected here where the sender can still see it.
  @MaxLength(4096)
  body!: string;
}

export class OpenConversationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;
}

export class SetStatusDto {
  @IsIn(['open', 'closed'])
  status!: 'open' | 'closed';
}

/** The n8n webhook body. Validated strictly: this is the one chat surface reachable without a session. */
export class InboundWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  body!: string;

  /** The gateway's own message id — the idempotency key for a redelivered webhook. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalId?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
