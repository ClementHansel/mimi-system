import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { ERR_AUTH_TOKEN_EXPIRED, ERR_AUTH_TOKEN_INVALID } from '@mimi/shared';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAccessPayload } from '../jwt/jwt-payload.interface';

/**
 * Global access-token guard (Passport strategy `'jwt'` — see
 * `jwt-access.strategy.ts`). Registered once via `APP_GUARD` in
 * `app.module.ts` so no Wave 3/4 module ever needs `@UseGuards(JwtAuthGuard)`
 * boilerplate on every controller; routes opt OUT with `@Public()`
 * (`/api/auth/login`, `/api/auth/refresh`, `/health`).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser = JwtAccessPayload>(
    err: unknown,
    user: TUser | false,
    info: { name?: string } | undefined,
  ): TUser {
    if (err || !user) {
      const code = info?.name === 'TokenExpiredError' ? ERR_AUTH_TOKEN_EXPIRED : ERR_AUTH_TOKEN_INVALID;
      throw new UnauthorizedException({ code, message: 'Invalid or expired access token' });
    }
    return user;
  }
}
