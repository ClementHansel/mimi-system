/** M01 `auth` — CONTRACTS.md §4.1. */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { LoginRes, Me, OfflineCredentialRes, RoleKey, UUID } from '@mimi/shared';
import { Audited, CurrentUser, Public, RequirePermission } from '../../common/decorators';
import { JwtRefreshGuard } from '../../common/guards/jwt-refresh.guard';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload, JwtRefreshPayload } from '../../common/jwt/jwt-payload.interface';
import { AuthLockoutService } from '../../kernel/auth-lockout/auth-lockout.service';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LogoutDto,
  OfflineCredentialRefreshDto,
  OfflineUnlockCodeDto,
  RefreshDto,
  RevokeCredentialDto,
  SetPinDto,
} from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly lockouts: AuthLockoutService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginRes> {
    return this.service.login(dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body() dto: RefreshDto,
    @CurrentUser() _payload: JwtRefreshPayload,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // `_payload` is re-verified inside the service (it needs the session row
    // too, not just the JWT claims) — accepted here only so JwtRefreshGuard
    // runs and rejects an invalid/expired refresh token before we do any work.
    return this.service.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Audited({ entityType: 'sessions', action: 'auth.logout' })
  logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<{ ok: true }> {
    return this.service.logout(dto, user, req.dbClient!);
  }

  @Get('me')
  me(@CurrentUser() user: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<Me> {
    return this.service.me(user, req.dbClient!);
  }

  @Post('pin')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('auth.pin.set')
  @Audited({ entityType: 'users', action: 'auth.pin.set' })
  setPin(
    @Body() dto: SetPinDto,
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<{ ok: true }> {
    return this.service.setPin(dto, user, req.dbClient!);
  }

  /**
   * B-17 — mints the unlock code for a credential a TABLET has locked out.
   *
   * Read out over the phone: the outlet has no internet (that is the entire
   * situation), so the device cannot be told anything directly. Same authority
   * rule as the online unlock — `auth.lockout.clear` plus a strict rank check
   * against the credential's holder, enforced in the service.
   *
   * `@Audited` matters here: this is the one path that converts head office's
   * authority into an offline authorization, and the audit row is the only
   * record that the phone call happened at all.
   */
  @Post('offline-credential/:credentialId/unlock-code')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('auth.lockout.clear')
  @Audited({ entityType: 'offline_credentials', action: 'auth.offline_credential.unlock_code' })
  async offlineUnlockCode(
    @Param('credentialId') credentialId: UUID,
    @Body() dto: OfflineUnlockCodeDto,
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<{ code: string; credentialId: UUID }> {
    // A pure read + a computation; nothing to commit, so no COMMIT here (unlike
    // the write routes in this controller — see "THE BIG ONE" in PROGRESS.md).
    return this.service.issueOfflineUnlockCode(credentialId, dto, user, req.dbClient!);
  }

  /**
   * B-15 Q6 — frees a caller who burned their approval-code attempts.
   *
   * The permission key is only half the gate: `AuthLockoutService.clear`
   * additionally requires the clearer to STRICTLY outrank the locked user
   * (`ROLE_RANK`), so a supervisor can free a kasir but not a peer. That is what
   * stops two cashiers taking turns unlocking each other and guessing all day.
   *
   * (`POST pin/verify` used to sit here. It was B-15 itself — see
   * `AuthService`'s comment where its body was, and do not bring it back.)
   */
  @Post('lockouts/:userId/clear')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('auth.lockout.clear')
  @Audited({ entityType: 'users', action: 'auth.lockout.clear' })
  async clearLockout(
    @Param('userId') userId: UUID,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<{ ok: true; cleared: boolean }> {
    const state = await this.lockouts.clear(userId, {
      userId: user.sub as UUID,
      roleKey: user.roleKey as RoleKey,
    });
    // `clear` owns its own committed transaction (RLS on `auth_lockouts` is
    // central-or-self, and a supervisor clearing a kasir is neither), so there
    // is deliberately no COMMIT on `req.dbClient` here.
    return { ok: true, cleared: state !== null };
  }

  /** A user may always see their own lock state, so a till can explain itself rather than just failing. */
  @Get('lockouts/me')
  async myLockout(
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<{ locked: boolean; hardLocked: boolean; lockedUntil: string | null }> {
    const state = await this.lockouts.find(req.dbClient!, user.sub as UUID);
    return {
      locked: Boolean(state && (state.hardLocked || state.lockedUntil)),
      hardLocked: state?.hardLocked ?? false,
      lockedUntil: state?.lockedUntil ?? null,
    };
  }

  @Post('offline-credential/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('auth.offline_credential.mint')
  @Audited({ entityType: 'offline_credentials', action: 'auth.offline_credential.mint' })
  refreshOfflineCredential(
    @Body() dto: OfflineCredentialRefreshDto,
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<OfflineCredentialRes> {
    return this.service.refreshOfflineCredential(dto, user, req.dbClient!);
  }

  @Post('offline-credential/:credentialId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('auth.offline_credential.mint', 'user.update')
  @Audited({ entityType: 'offline_credentials', action: 'auth.offline_credential.revoke' })
  revokeOfflineCredential(
    @Param('credentialId') credentialId: string,
    @Body() dto: RevokeCredentialDto,
    @CurrentUser() user: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<{ ok: true }> {
    return this.service.revokeOfflineCredential(credentialId, dto, user, req.dbClient!);
  }
}
