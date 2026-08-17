import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { ApproveRunDto, MarkPaidDto, OverrideLineDto, RejectRunDto, SendSlipsDto } from '../dto/payroll.dto';
import { RunsService } from './runs.service';

/** CONTRACTS.md §4.15 — `/api/payroll/runs*` and `/api/payroll/my-slips`. */
@Controller('payroll')
export class RunsController {
  constructor(private readonly service: RunsService) {}

  @Get('runs/:id')
  @RequirePermission('payroll.read')
  async getRun(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getRunDetail(req.dbClient!, id);
  }

  @Patch('runs/:id/lines/:lineId')
  @RequirePermission('payroll.run.calculate')
  @Audited({ module: 'payroll', entityType: 'payroll_lines', action: 'payroll.run.calculate' })
  async overrideLine(@Req() req: RequestWithDbContext, @Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: OverrideLineDto) {
    return this.service.overrideLine(req.dbClient!, id, lineId, dto);
  }

  @Post('runs/:id/recalculate')
  @RequirePermission('payroll.run.calculate')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.calculate' })
  async recalculate(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.recalculate(req.dbClient!, req.user!.sub, id);
  }

  @Post('runs/:id/submit')
  @RequirePermission('payroll.run.submit')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.submit' })
  async submit(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.submit(req.dbClient!, req.user!.sub, id);
  }

  @Post('runs/:id/approve')
  @RequirePermission('payroll.run.approve')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.approve' })
  async approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApproveRunDto) {
    return this.service.approve(req.dbClient!, req.user!.sub, req.user!.roleKey, id, dto.note);
  }

  @Post('runs/:id/reject')
  @RequirePermission('payroll.run.approve')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.approve' })
  async reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectRunDto) {
    return this.service.reject(req.dbClient!, req.user!.sub, req.user!.roleKey, id, dto.reason);
  }

  @Post('runs/:id/mark-paid')
  @RequirePermission('payroll.run.pay')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.run.pay' })
  async markPaid(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: MarkPaidDto) {
    return this.service.markPaid(req.dbClient!, req.user!.sub, id, dto.paymentVerificationId);
  }

  @Post('runs/:id/send-slips')
  @RequirePermission('payroll.slip.send')
  @Audited({ module: 'payroll', entityType: 'payroll_runs', action: 'payroll.slip.send' })
  async sendSlips(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: SendSlipsDto) {
    return this.service.sendSlips(req.dbClient!, id, dto.channels);
  }

  @Get('my-slips')
  @RequirePermission('payroll.slip.read.own')
  async mySlips(@Req() req: RequestWithDbContext, @Query('year') year?: string) {
    return this.service.mySlips(req.dbClient!, req.user!.sub, year);
  }
}
