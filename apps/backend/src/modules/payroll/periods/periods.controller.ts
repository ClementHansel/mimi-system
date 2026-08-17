import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { CalculatePeriodDto, CreatePeriodDto } from '../dto/payroll.dto';
import { RunsService } from '../runs/runs.service';
import { PeriodsService } from './periods.service';

/** CONTRACTS.md §4.15 — `/api/payroll/periods*`. */
@Controller('payroll/periods')
export class PeriodsController {
  constructor(
    private readonly periods: PeriodsService,
    private readonly runs: RunsService,
  ) {}

  @Get()
  @RequirePermission('payroll.read')
  async list(@Req() req: RequestWithDbContext, @Query('page') page?: string) {
    return this.periods.list(req.dbClient!, page ? parseInt(page, 10) : 1);
  }

  @Post()
  @RequirePermission('payroll.run.calculate')
  @Audited({ module: 'payroll', entityType: 'payroll_periods', action: 'payroll.run.calculate' })
  async create(@Req() req: RequestWithDbContext, @Body() dto: CreatePeriodDto) {
    return this.periods.create(req.dbClient!, dto.periodCode);
  }

  @Post(':id/calculate')
  @RequirePermission('payroll.run.calculate')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.calculate' })
  async calculate(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: CalculatePeriodDto) {
    return this.runs.calculateForPeriod(req.dbClient!, req.user!.sub, id, dto.employeeIds);
  }
}
