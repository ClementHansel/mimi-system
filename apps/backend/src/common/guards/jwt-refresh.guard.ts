import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ERR_AUTH_TOKEN_INVALID } from '@mimi/shared';
import { JwtRefreshPayload } from '../jwt/jwt-payload.interface';

/**
 * Guards ONLY `POST /api/auth/refresh` (Passport strategy `'jwt-refresh'`).
 * Never registered globally — applied explicitly by M01 `auth`:
 *
 *   @Public()
 *   @UseGuards(JwtRefreshGuard)
 *   @Post('refresh')
 *   refresh(@CurrentUser() payload: JwtRefreshPayload) { ... }
 *
 * `@Public()` is required alongside this because the global `JwtAuthGuard`
 * would otherwise reject the request first for lacking an access-token
 * Authorization header.
 */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  handleRequest<TUser = JwtRefreshPayload>(err: unknown, user: TUser | false): TUser {
    if (err || !user) {
      throw new UnauthorizedException({ code: ERR_AUTH_TOKEN_INVALID, message: 'Invalid or expired refresh token' });
    }
    return user;
  }
}
