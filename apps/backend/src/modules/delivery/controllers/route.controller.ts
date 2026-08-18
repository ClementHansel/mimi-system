import { Body, Controller, Param, Patch, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../../common/decorators';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { requireDbClient } from '../request-db-client';
import { RouteService } from '../services/route.service';
import { PlanRouteDto, SetDropInstructionsDto } from '../dto/route.dto';

/**
 * M10 `delivery` — gudang's route planning for a Surat Jalan.
 *
 * Gated on `delivery.sj.create` (kepala_gudang only), the same permission
 * `PATCH /delivery/surat-jalan/:id` already uses: planning the route is editing
 * the dispatch document, not a separate authority. Deliberately NOT
 * `delivery.drop.execute` — that is held by drivers too, and a driver must not
 * be able to rewrite the route they were given.
 */
@Controller('delivery/surat-jalan')
export class RouteController {
  constructor(private readonly route: RouteService) {}

  /** Replace the stop order (and optionally the per-stop briefs) wholesale.
   * PUT, not PATCH: the body is the complete route, and a partial reorder is
   * not a meaningful operation — every stop needs a sequence. */
  @Put(':id/route')
  @RequirePermission('delivery.sj.create')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.create' })
  planRoute(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PlanRouteDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.route.planRoute(requireDbClient(req), id, dto, user.sub);
  }

  /** Update ONE stop's delivery brief without touching the order — allowed
   * later in the lifecycle than a reorder, so a dispatcher can warn a driver
   * mid-route. See `RouteService.setInstructions`. */
  @Patch('drops/:dropId/instructions')
  @RequirePermission('delivery.sj.create')
  @Audited({ entityType: 'sj_drop', action: 'delivery.sj.create' })
  setInstructions(
    @Req() req: Request,
    @Param('dropId') dropId: string,
    @Body() dto: SetDropInstructionsDto,
  ) {
    return this.route.setInstructions(
      requireDbClient(req),
      dropId,
      dto.deliveryInstructions ?? null,
    );
  }
}
