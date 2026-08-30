/** M20 `settings` — CONTRACTS.md §4.20. */
import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ApprovalChainRes, ApprovalModeRes, SettingRes, SettingsService } from './settings.service';
import { EmailSettingsRes, EmailSettingsService } from './email-settings.service';
import {
  ListSettingsQueryDto,
  PutApprovalChainDto,
  PutApprovalModeDto,
  PutEmailSettingsDto,
  PutSettingDto,
} from './settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    private readonly emailSettings: EmailSettingsService,
  ) {}

  // ── Per-tenant outbound email (migration 264) ──────────────────────────────
  //
  // No `:tenantId` anywhere in these routes, deliberately. The tenant comes
  // from the session that `RlsContextGuard` established, and the RLS policy on
  // `tenant_email_settings` is what confines the query. A route that accepted a
  // tenant id would let an owner read or rewrite another company's mail
  // credentials, which is the one thing this whole boundary exists to prevent.

  @Get('email')
  @RequirePermission('settings.read')
  getEmailSettings(@Req() req: RequestWithDbContext): Promise<EmailSettingsRes | null> {
    return this.emailSettings.get(req.dbClient!);
  }

  @Put('email')
  @RequirePermission('settings.manage')
  @Audited({ entityType: 'tenant_email_settings', action: 'settings.email.manage' })
  putEmailSettings(
    @Body() dto: PutEmailSettingsDto,
    @Req() req: RequestWithDbContext,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<EmailSettingsRes> {
    return this.emailSettings.save(req.dbClient!, dto, user.sub);
  }

  /**
   * Opens a real connection and authenticates WITHOUT sending mail, then
   * records the verdict. A "Save" that only stores a string tells the user
   * nothing about whether their App Password actually works — and the whole
   * point of them doing their own 2FA setup is that they can check it here
   * rather than discovering it from a notification that never arrived.
   */
  @Post('email/test')
  @RequirePermission('settings.manage')
  testEmailSettings(
    @Req() req: RequestWithDbContext,
  ): Promise<{ ok: boolean; error: string | null }> {
    return this.emailSettings.test(req.dbClient!);
  }

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
