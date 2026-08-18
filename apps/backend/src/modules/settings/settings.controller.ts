/** M20 `settings` — CONTRACTS.md §4.20. */
import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ApprovalChainRes, ApprovalModeRes, SettingRes, SettingsService } from './settings.service';
import {
  ListSettingsQueryDto,
  PutApprovalChainDto,
  PutApprovalModeDto,
  PutSettingDto,
} from './settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @RequirePermission('settings.read')
  list(
    @Query() query: ListSettingsQueryDto,
    @Req() req: RequestWithDbContext,
  ): Promise<SettingRes[]> {
    return this.service.list(query.prefix, req.dbClient!);
  }

  @Get('approval-chains')
  @RequirePermission('settings.read')
  listApprovalChains(@Req() req: RequestWithDbContext): Promise<ApprovalChainRes[]> {
    return this.service.listApprovalChains(req.dbClient!);
  }

  @Put('approval-chains/:documentType')
  @RequirePermission('settings.approval_chain.manage')
  @Audited({ entityType: 'approval_chain_steps', action: 'settings.approval_chain.manage' })
  putApprovalChain(
    @Param('documentType') documentType: string,
    @Body() dto: PutApprovalChainDto,
    @Req() req: RequestWithDbContext,
  ): Promise<ApprovalChainRes> {
    return this.service.putApprovalChain(documentType, dto, req.dbClient!);
  }

  @Get('approval-modes')
  @RequirePermission('settings.read')
  listApprovalModes(@Req() req: RequestWithDbContext): Promise<ApprovalModeRes[]> {
    return this.service.getApprovalModes(req.dbClient!);
  }

  @Put('approval-modes/:documentType')
  @RequirePermission('settings.approval_mode.manage')
  @Audited({ entityType: 'approval_mode', action: 'settings.approval_mode.manage' })
  putApprovalMode(
    @Param('documentType') documentType: string,
    @Body() dto: PutApprovalModeDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<ApprovalModeRes> {
    return this.service.putApprovalMode(documentType, dto, caller, req.dbClient!);
  }

  @Get(':key')
  @RequirePermission('settings.read')
  getOne(@Param('key') key: string, @Req() req: RequestWithDbContext): Promise<SettingRes> {
    return this.service.getOne(key, req.dbClient!);
  }

  @Put(':key')
  @RequirePermission('settings.manage')
  @Audited({ entityType: 'settings', action: 'settings.manage' })
  putOne(
    @Param('key') key: string,
    @Body() dto: PutSettingDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<SettingRes> {
    return this.service.putOne(key, dto, caller, req.dbClient!);
  }
}
