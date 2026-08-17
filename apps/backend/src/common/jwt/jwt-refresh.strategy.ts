import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import { Request } from 'express';
import { JwtRefreshPayload } from './jwt-payload.interface';
import { refreshSecret } from './jwt-secrets';

/**
 * Validates the refresh token. Unlike the access strategy, the token arrives
 * in the request BODY (CONTRACTS.md §4.1 `POST /api/auth/refresh` — `{refreshToken}`),
 * not an Authorization header, since the refresh flow has no access token to
 * send. Registered as Passport strategy `'jwt-refresh'`; guarded explicitly
 * with `JwtRefreshGuard` only on the refresh route (never global), and that
 * route must also be `@Public()` so the global `JwtAuthGuard` doesn't reject
 * it first for lacking a Bearer header.
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: (req: Request): string | null => {
        const body = req.body as Record<string, unknown> | undefined;
        return typeof body?.refreshToken === 'string' ? body.refreshToken : null;
      },
      ignoreExpiration: false,
      secretOrKey: refreshSecret(config),
    });
  }

  validate(payload: JwtRefreshPayload): JwtRefreshPayload {
    return payload;
  }
}
