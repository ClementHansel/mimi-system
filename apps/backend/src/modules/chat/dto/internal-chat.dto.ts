import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Internal (staff-to-staff) chat DTOs — person-to-person and group.
 * Message bodies reuse `SendMessageDto` from `./chat.dto`: same shape, same
 * 4096-char bound, no reason for the internal limit to differ.
 */
export class OpenDirectDto {
  @IsUUID()
  userId!: string;
}

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  // At least one member besides the creator: a "group" whose only member is
  // its own creator is a direct conversation with nobody, not a feature.
  // Capped at 200 — high enough for any real staff/outlet roster, low
  // enough that a client bug sending every user in the company fails fast
  // with a validation error instead of a 200-row insert.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  memberIds!: string[];
}

export class RenameGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}

export class AddMemberDto {
  @IsUUID()
  userId!: string;
}
