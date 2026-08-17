import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAccessPayload, JwtRefreshPayload } from './jwt-payload.interface';
import { accessSecret, refreshSecret } from './jwt-secrets';

/**
 * Signs and verifies both token families with independent secrets/TTLs, per
 * BUILD-PLAN W1-D ("Include the refresh-token verification path"). Two
 * `JwtService` instances are constructed directly (not via `JwtModule`
 * DI-registration) because Nest's `JwtModule` only supports one global
 * configuration per module — access and refresh tokens need different
 * secrets so a leaked access token can never be replayed as a refresh token.
 *
 * Env vars match `.env.example` / `docker-compose.yml` exactly:
 * `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN`.
 */
@Injectable()
export class TokenService {
  private readonly accessJwt: JwtService;
  private readonly refreshJwt: JwtService;

  constructor(config: ConfigService) {
    // `expiresIn` is typed `number | StringValue` upstream (the `ms` package's
    // template-literal type, e.g. `'15m'`) — env vars arrive as plain
    // `string`, so the cast below is a type-level formality only; jsonwebtoken
    // parses '15m'/'7d' identically regardless of this file's TS annotation.
    this.accessJwt = new JwtService({
      secret: accessSecret(config),
      signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '15m') as unknown as number },
    });
    this.refreshJwt = new JwtService({
      secret: refreshSecret(config),
      signOptions: { expiresIn: config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d') as unknown as number },
    });
  }

  signAccessToken(payload: JwtAccessPayload): string {
    return this.accessJwt.sign({ ...payload });
  }

  verifyAccessToken(token: string): JwtAccessPayload {
    return this.accessJwt.verify<JwtAccessPayload>(token);
  }

  signRefreshToken(payload: JwtRefreshPayload): string {
    return this.refreshJwt.sign({ ...payload });
  }

  verifyRefreshToken(token: string): JwtRefreshPayload {
    return this.refreshJwt.verify<JwtRefreshPayload>(token);
  }
}
