import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

/** `POST /api/stock-opname/:id/lines/:lineId/resolve` — resolves a C1 double-count dispute (SYNC-PROTOCOL §5.2). */
export class ResolveOpnameLineDto {
  /** The winning `sync_events.event_id` between the two conflicting counts. */
  @IsUUID()
  chosenEventId!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
