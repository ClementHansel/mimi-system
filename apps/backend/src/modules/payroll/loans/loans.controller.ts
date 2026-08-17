import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { ApproveLoanDto, CreateLoanDto, RejectLoanDto } from '../dto/payroll.dto';
import { LoansService } from './loans.service';

/** CONTRACTS.md §4.15 — `/api/payroll/loans*`. */
@Controller('payroll/loans')
export class LoansController {
  constructor(private readonly service: LoansService) {}

  @Get()
  @RequirePermission('payroll.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list(req.dbClient!, employeeId, status, page ? parseInt(page, 10) : 1, pageSize ? parseInt(pageSize, 10) : 50);
  }

  @Post()
  @RequirePermission('payroll.loan.manage')
  @Audited({ module: 'payroll', entityType: 'employee_loans', action: 'payroll.loan.manage' })
  async create(@Req() req: RequestWithDbContext, @Body() dto: CreateLoanDto) {
    return this.service.create(req.dbClient!, req.user!.sub, dto);
  }

  @Post(':id/approve')
  @RequirePermission('payroll.loan.approve')
  @Audited({ module: 'payroll', entityType: 'employee_loans', action: 'payroll.loan.approve' })
  async approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApproveLoanDto) {
    return this.service.approve(req.dbClient!, req.user!.sub, req.user!.roleKey, id, dto.note);
  }

  @Post(':id/reject')
  @RequirePermission('payroll.loan.approve')
  @Audited({ module: 'payroll', entityType: 'employee_loans', action: 'payroll.loan.approve' })
  async reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectLoanDto) {
    return this.service.reject(req.dbClient!, req.user!.sub, req.user!.roleKey, id, dto.reason);
  }

  @Get(':id/schedule')
  @RequirePermission('payroll.read')
  async schedule(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.schedule(req.dbClient!, id);
  }
}
