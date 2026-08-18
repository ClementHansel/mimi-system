import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { AttendanceRow, Paginated } from '@mimi/shared';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { CheckAttendanceDto, CorrectAttendanceDto } from '../dto/attendance.dto';
import { AttendanceService, AttendanceSummaryRow } from './attendance.service';

/** CONTRACTS.md §4.14 — `/api/hr/attendance*`. */
@Controller('hr/attendance')
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  @Post('check-in')
  @RequirePermission('hr.attendance.check')
  @Audited({ module: 'hr', entityType: 'attendance', action: 'hr.attendance.check' })
  async checkIn(
    @Req() req: RequestWithDbContext,
    @Body() dto: CheckAttendanceDto,
  ): Promise<AttendanceRow> {
    return this.service.checkIn(req.dbClient!, req.user!, dto);
  }

  @Post('check-out')
  @RequirePermission('hr.attendance.check')
  @Audited({ module: 'hr', entityType: 'attendance', action: 'hr.attendance.check' })
  async checkOut(
    @Req() req: RequestWithDbContext,
    @Body() dto: CheckAttendanceDto,
  ): Promise<AttendanceRow> {
    return this.service.checkOut(req.dbClient!, req.user!, dto);
  }

  @Get('me')
  @RequirePermission('hr.attendance.check')
  async me(
    @Req() req: RequestWithDbContext,
    @Query('month') month?: string,
  ): Promise<AttendanceRow[]> {
    return this.service.listMe(req.dbClient!, req.user!, month);
  }

  @Get()
  @RequirePermission('hr.attendance.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('date') date?: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<AttendanceRow>> {
    return this.service.list(
      req.dbClient!,
      req.user!,
      locationId,
      date,
      employeeId,
      status,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Patch(':id')
  @RequirePermission('hr.attendance.correct')
  @Audited({ module: 'hr', entityType: 'attendance', action: 'hr.attendance.correct' })
  async correct(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: CorrectAttendanceDto,
  ): Promise<AttendanceRow> {
    return this.service.correct(req.dbClient!, req.user!, id, dto);
  }

  @Get('summary')
  @RequirePermission('hr.attendance.read')
  async summary(
    @Req() req: RequestWithDbContext,
    @Query('periodCode') periodCode: string,
    @Query('locationId') locationId?: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<AttendanceSummaryRow[]> {
    return this.service.summary(req.dbClient!, periodCode, locationId, employeeId);
  }
}
