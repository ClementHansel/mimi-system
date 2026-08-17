import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  DisableStatutoryDto,
  EnableStatutoryDto,
  PutArticle17Dto,
  PutBpjsDto,
  PutPtkpDto,
  PutTaxProfileDto,
  PutTerDto,
} from '../dto/payroll.dto';
import { StatutoryService } from './statutory.service';

/** CONTRACTS.md §4.15 — `/api/payroll/statutory*` (Amendment 1 wizard) and `/api/payroll/employees/:employeeId/tax-profile`. */
@Controller('payroll')
export class StatutoryController {
  constructor(private readonly service: StatutoryService) {}

  @Get('statutory/status')
  @RequirePermission('payroll.statutory.read')
  async status(@Req() req: RequestWithDbContext) {
    return this.service.getStatus(req.dbClient!);
  }

  @Get('statutory/bpjs')
  @RequirePermission('payroll.statutory.read')
  async getBpjs(@Req() req: RequestWithDbContext, @Query('program') program?: string, @Query('asOf') asOf?: string) {
    return this.service.getBpjs(req.dbClient!, program, asOf);
  }

  @Put('statutory/bpjs')
  @RequirePermission('payroll.statutory.config')
  @Audited({ module: 'payroll', entityType: 'bpjs_configs', action: 'payroll.statutory.config' })
  async putBpjs(@Req() req: RequestWithDbContext, @Body() dto: PutBpjsDto) {
    return this.service.putBpjs(req.dbClient!, dto);
  }

  @Get('statutory/pph21/ter')
  @RequirePermission('payroll.statutory.read')
  async getTer(@Req() req: RequestWithDbContext, @Query('category') category?: string, @Query('asOf') asOf?: string) {
    return this.service.getTer(req.dbClient!, category, asOf);
  }

  @Put('statutory/pph21/ter')
  @RequirePermission('payroll.statutory.config')
  @Audited({ module: 'payroll', entityType: 'pph21_ter_rates', action: 'payroll.statutory.config' })
  async putTer(@Req() req: RequestWithDbContext, @Body() dto: PutTerDto) {
    return this.service.putTer(req.dbClient!, dto);
  }

  @Get('statutory/pph21/ptkp')
  @RequirePermission('payroll.statutory.read')
  async getPtkp(@Req() req: RequestWithDbContext, @Query('asOf') asOf?: string) {
    return this.service.getPtkp(req.dbClient!, asOf);
  }

  @Put('statutory/pph21/ptkp')
  @RequirePermission('payroll.statutory.config')
  @Audited({ module: 'payroll', entityType: 'pph21_ptkp', action: 'payroll.statutory.config' })
  async putPtkp(@Req() req: RequestWithDbContext, @Body() dto: PutPtkpDto) {
    return this.service.putPtkp(req.dbClient!, dto);
  }

  @Get('statutory/pph21/article17')
  @RequirePermission('payroll.statutory.read')
  async getArticle17(@Req() req: RequestWithDbContext, @Query('asOf') asOf?: string) {
    return this.service.getArticle17(req.dbClient!, asOf);
  }

  @Put('statutory/pph21/article17')
  @RequirePermission('payroll.statutory.config')
  @Audited({ module: 'payroll', entityType: 'pph21_article17_brackets', action: 'payroll.statutory.config' })
  async putArticle17(@Req() req: RequestWithDbContext, @Body() dto: PutArticle17Dto) {
    return this.service.putArticle17(req.dbClient!, dto);
  }

  @Get('employees/:employeeId/tax-profile')
  @RequirePermission('payroll.statutory.read')
  async getTaxProfile(@Req() req: RequestWithDbContext, @Param('employeeId') employeeId: string) {
    return this.service.getTaxProfile(req.dbClient!, employeeId);
  }

  @Put('employees/:employeeId/tax-profile')
  @RequirePermission('payroll.statutory.config')
  @Audited({ module: 'payroll', entityType: 'employee_tax_profiles', action: 'payroll.statutory.config' })
  async putTaxProfile(@Req() req: RequestWithDbContext, @Param('employeeId') employeeId: string, @Body() dto: PutTaxProfileDto) {
    return this.service.putTaxProfile(req.dbClient!, req.user!.sub, employeeId, dto);
  }

  @Post('statutory/enable')
  @RequirePermission('payroll.statutory.enable')
  @Audited({ module: 'payroll', entityType: 'settings', action: 'payroll.statutory.enable' })
  async enable(@Req() req: RequestWithDbContext, @Body() _dto: EnableStatutoryDto) {
    return this.service.enable(req.dbClient!, req.user!.sub);
  }

  @Post('statutory/disable')
  @RequirePermission('payroll.statutory.enable')
  @Audited({ module: 'payroll', entityType: 'settings', action: 'payroll.statutory.enable' })
  async disable(@Req() req: RequestWithDbContext, @Body() dto: DisableStatutoryDto) {
    return this.service.disable(req.dbClient!, req.user!.sub, dto.reason);
  }
}
