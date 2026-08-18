import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, RequirePermission } from '../../../common/decorators';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { requireDbClient } from '../request-db-client';
import { TrackingService } from '../services/tracking.service';
import { RecordPositionsDto } from '../dto/tracking.dto';

/**
 * M10 `delivery` — live truck tracking (migration 221).
 *
 * Writes are gated on `delivery.drop.execute` (kepala_gudang + driver) because
 * reporting position is part of executing the trip; reads on `delivery.read`,
 * the same permission the dispatcher already needs to see the Surat Jalan.
 * RLS narrows both further: a driver only ever reaches their own SJ.
 *
 * NOT `@Audited`: a position batch is high-frequency telemetry, and auditing
 * every ping would swamp the audit log with rows nobody will read while making
 * the genuinely interesting delivery events harder to find. The positions table
 * is itself the append-only record.
 */
@Controller('delivery')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  /** Batch ingest from the driver PWA, including offline-queued fixes. */
  @Post('surat-jalan/:id/positions')
  @RequirePermission('delivery.drop.execute')
  recordPositions(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: RecordPositionsDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.tracking.recordPositions(requireDbClient(req), id, dto, user.sub);
  }

  /** The breadcrumb trail for one trip. `since` (ISO timestamp) returns only
   * the tail, so a live view polls cheaply instead of refetching the day. */
  @Get('surat-jalan/:id/positions')
  @RequirePermission('delivery.read')
  getTrail(@Req() req: Request, @Param('id') id: string, @Query('since') since?: string) {
    return this.tracking.getTrail(requireDbClient(req), id, since);
  }

  /** Every dispatched truck plus its latest fix — the dispatcher's live board. */
  @Get('live')
  @RequirePermission('delivery.read')
  getLiveBoard(@Req() req: Request) {
    return this.tracking.getLiveBoard(requireDbClient(req));
  }
}
