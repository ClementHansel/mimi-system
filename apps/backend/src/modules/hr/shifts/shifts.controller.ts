import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { CreateShiftDto, UpdateShiftDto, UpsertRosterDto } from '../dto/shift.dto';
import { RosterRow, ShiftDto, ShiftsService } from './shifts.service';

/** CONTRACTS.md §4.14 — `/api/hr/shifts*`, `/api/hr/roster`. */
@Controller('api/hr')
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get('shifts')
  @RequirePermission('hr.shift.read')
  async listShifts(@Req() req: RequestWithDbContext, @Query('locationId') locationId?: string): Promise<ShiftDto[]> {
    return this.service.listShifts(req.dbClient!, locationId);
  }

  @Post('shifts')
  @RequirePermission('hr.shift.manage')
  @Audited({ module: 'hr', entityType: 'work_shifts', action: 'hr.shift.manage' })
  async createShift(@Req() req: RequestWithDbContext, @Body() dto: CreateShiftDto): Promise<ShiftDto> {
    return this.service.createShift(req.dbClient!, req.user!.sub, dto);
  }

  @Patch('shifts/:id')
  @RequirePermission('hr.shift.manage')
  @Audited({ module: 'hr', entityType: 'work_shifts', action: 'hr.shift.manage' })
  async updateShift(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: UpdateShiftDto): Promise<ShiftDto> {
    return this.service.updateShift(req.dbClient!, req.user!.sub, id, dto);
  }

  @Get('roster')
  @RequirePermission('hr.shift.read')
  async getRoster(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<RosterRow[]> {
    return this.service.getRoster(req.dbClient!, locationId, from, to, employeeId);
  }

  @Put('roster')
  @RequirePermission('hr.shift.manage')
  @Audited({ module: 'hr', entityType: 'shift_assignments', action: 'hr.shift.manage' })
  async upsertRoster(@Req() req: RequestWithDbContext, @Body() dto: UpsertRosterDto): Promise<{ updated: number }> {
    return this.service.upsertRoster(req.dbClient!, req.user!.sub, dto);
  }
}
