/**
 * `GET /api/topology` / `GET /api/topology/summary` (CONTRACTS.md §4.21,
 * §7.4-§7.5). Owner/Manager (`topology.read`, both central roles per
 * `app_is_central()`) — RLS auto-bypasses to unrestricted for them, so the
 * assembled tree naturally spans every location with zero extra scoping
 * code here.
 */
import { Controller, Get, Req } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { TopologyService } from './topology.service';

@Controller('topology')
export class TopologyController {
  constructor(private readonly topology: TopologyService) {}

  @RequirePermission('topology.read')
  @Get()
  async tree(@Req() req: RequestWithDbContext) {
    return this.topology.buildTree(req.dbClient);
  }

  @RequirePermission('topology.read')
  @Get('summary')
  async summary(@Req() req: RequestWithDbContext) {
    return this.topology.buildSummary(req.dbClient);
  }
}
