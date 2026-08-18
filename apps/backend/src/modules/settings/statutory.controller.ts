/**
 * D-18 statutory payroll wizard — CONTRACTS.md §4.15.
 *
 * CONTRACT DEVIATION (flagged for the architect/W4-01, see
 * `statutory.repository.ts`'s file header for the full reasoning):
 * CONTRACTS.md places this exact endpoint set at `/api/payroll/statutory/*`
 * (M15 `payroll`, Wave 4, agent W4-01). Per an explicit coordinator
 * directive, this agent ships it here at `/api/settings/statutory/*`
 * instead, using the identical request/response shapes, error codes, and
 * permission keys CONTRACTS.md §4.15 specifies.
 */
import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { StatutoryStatus } from '@mimi/shared';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { StatutoryService, type TaxProfile } from './statutory.service';
import {
  DisableStatutoryDto,
  EnableStatutoryDto,
  PutArticle17Dto,
  PutBpjsDto,
  PutPtkpDto,
  PutTerDto,
  TaxProfileDto,
} from './statutory.dto';

@Controller('settings/statutory')
export class StatutoryController {
  constructor(private readonly service: StatutoryService) {}

  @Get('status')
  @RequirePermission('payroll.statutory.read')
  status(@Req() req: RequestWithDbContext): Promise<StatutoryStatus> {
    return this.service.status(req.dbClient!);
  }

  @Get('bpjs')
  @RequirePermission('payroll.statutory.read')
  listBpjs(
    @Query('program') program: string | undefined,
    @Query('asOf') asOf: string | undefined,
    @Req() req: RequestWithDbContext,
  ) {
    return this.service.listBpjs(req.dbClient!, program, asOf);
  }

  @Put('bpjs')
  @RequirePermission('payroll.statutory.config')
  @Audited({ entityType: 'bpjs_configs', action: 'payroll.statutory.config' })
  putBpjs(@Body() dto: PutBpjsDto, @Req() req: RequestWithDbContext) {
    return this.service.putBpjs(dto, req.dbClient!);
  }

  @Get('pph21/ter')
  @RequirePermission('payroll.statutory.read')
  listTer(
    @Query('category') category: string | undefined,
    @Query('asOf') asOf: string | undefined,
    @Req() req: RequestWithDbContext,
  ) {
    return this.service.listTer(req.dbClient!, category, asOf);
  }

  @Put('pph21/ter')
  @RequirePermission('payroll.statutory.config')
  @Audited({ entityType: 'pph21_ter_rates', action: 'payroll.statutory.config' })
  putTer(@Body() dto: PutTerDto, @Req() req: RequestWithDbContext) {
    return this.service.putTer(dto, req.dbClient!);
  }

  @Get('pph21/ptkp')
  @RequirePermission('payroll.statutory.read')
  listPtkp(@Query('asOf') asOf: string | undefined, @Req() req: RequestWithDbContext) {
    return this.service.listPtkp(req.dbClient!, asOf);
  }

  @Put('pph21/ptkp')
  @RequirePermission('payroll.statutory.config')
  @Audited({ entityType: 'pph21_ptkp', action: 'payroll.statutory.config' })
  putPtkp(@Body() dto: PutPtkpDto, @Req() req: RequestWithDbContext) {
    return this.service.putPtkp(dto, req.dbClient!);
  }

  @Get('pph21/article17')
  @RequirePermission('payroll.statutory.read')
  listArticle17(@Query('asOf') asOf: string | undefined, @Req() req: RequestWithDbContext) {
    return this.service.listArticle17(req.dbClient!, asOf);
  }

  @Put('pph21/article17')
  @RequirePermission('payroll.statutory.config')
  @Audited({ entityType: 'pph21_article17_brackets', action: 'payroll.statutory.config' })
  putArticle17(@Body() dto: PutArticle17Dto, @Req() req: RequestWithDbContext) {
    return this.service.putArticle17(dto, req.dbClient!);
  }

  @Get('employees/:employeeId/tax-profile')
  @RequirePermission('payroll.statutory.read')
  getTaxProfile(
    @Param('employeeId') employeeId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<TaxProfile> {
    return this.service.getTaxProfile(employeeId, req.dbClient!);
  }

  @Put('employees/:employeeId/tax-profile')
  @RequirePermission('payroll.statutory.config')
  @Audited({ entityType: 'employee_tax_profiles', action: 'payroll.statutory.config' })
  putTaxProfile(
    @Param('employeeId') employeeId: string,
    @Body() dto: TaxProfileDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<TaxProfile> {
    return this.service.putTaxProfile(employeeId, dto, caller, req.dbClient!);
  }

  @Post('enable')
  @RequirePermission('payroll.statutory.enable')
  @Audited({ entityType: 'settings', action: 'payroll.statutory.enable' })
  enable(
    @Body() dto: EnableStatutoryDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<StatutoryStatus> {
    return this.service.enable(dto, caller, req.dbClient!);
  }

  @Post('disable')
  @RequirePermission('payroll.statutory.enable')
  @Audited({ entityType: 'settings', action: 'payroll.statutory.enable' })
  disable(
    @Body() dto: DisableStatutoryDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<StatutoryStatus> {
    return this.service.disable(dto, caller, req.dbClient!);
  }
}
