import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { LeaveStatus, LeaveType, Paginated, RoleKey } from '@mimi/shared';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { ApproveLeaveDto, RejectLeaveDto, SubmitLeaveDto } from '../dto/leave.dto';
import { LeaveQuota, LeaveRow, LeavesService } from './leaves.service';

/** CONTRACTS.md §4.14 — `/api/hr/leaves*`. */
@Controller('hr/leaves')
export class LeavesController {
  constructor(private readonly service: LeavesService) {}

  @Get()
  @RequirePermission('hr.leave.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('status') status?: LeaveStatus,
    @Query('type') type?: LeaveType,
    @Query('employeeId') employeeId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<LeaveRow>> {
    return this.service.list(
      req.dbClient!,
      locationId,
      status,
      type,
      employeeId,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Get('me')
  @RequirePermission('hr.leave.request')
  async me(
    @Req() req: RequestWithDbContext,
    @Query('year') year?: string,
  ): Promise<{ rows: LeaveRow[]; quota: LeaveQuota }> {
    return this.service.listMe(req.dbClient!, req.user!.sub, year);
  }

  @Post()
  @RequirePermission('hr.leave.request')
  @Audited({ module: 'hr', entityType: 'leave_requests', action: 'hr.leave.request' })
  async submit(@Req() req: RequestWithDbContext, @Body() dto: SubmitLeaveDto): Promise<LeaveRow> {
    return this.service.submit(req.dbClient!, req.user!.sub, dto);
  }

  @Post(':id/approve')
  @RequirePermission('hr.leave.approve')
  @Audited({ module: 'hr', entityType: 'leave_requests', action: 'hr.leave.approve' })
  async approve(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: ApproveLeaveDto,
  ): Promise<LeaveRow> {
    return this.service.approve(
      req.dbClient!,
      req.user!.sub,
      req.user!.roleKey as RoleKey,
      id,
      dto,
    );
  }

  @Post(':id/reject')
  @RequirePermission('hr.leave.approve')
  @Audited({ module: 'hr', entityType: 'leave_requests', action: 'hr.leave.approve' })
  async reject(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: RejectLeaveDto,
  ): Promise<LeaveRow> {
    return this.service.reject(req.dbClient!, req.user!.sub, req.user!.roleKey as RoleKey, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('hr.leave.request')
  @Audited({ module: 'hr', entityType: 'leave_requests', action: 'hr.leave.request' })
  async cancel(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<LeaveRow> {
    return this.service.cancel(req.dbClient!, req.user!.sub, req.user!.roleKey as RoleKey, id);
  }
}
