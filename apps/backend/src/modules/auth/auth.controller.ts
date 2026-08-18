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
import type { LoginRes, Me, OfflineCredentialRes } from '@mimi/shared';
import { Audited, CurrentUser, Public, RequirePermission } from '../../common/decorators';
import { JwtRefreshGuard } from '../../common/guards/jwt-refresh.guard';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload, JwtRefreshPayload } from '../../common/jwt/jwt-payload.interface';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LogoutDto,
  OfflineCredentialRefreshDto,
  RefreshDto,
  RevokeCredentialDto,
  SetPinDto,
  VerifyPinDto,
} from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

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

  @Post('pin/verify')
  @HttpCode(HttpStatus.OK)
  verifyPin(
    @Body() dto: VerifyPinDto,
  ): Promise<{ ok: true; verifierToken: string; expiresAt: string }> {
    return this.service.verifyPin(dto);
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
