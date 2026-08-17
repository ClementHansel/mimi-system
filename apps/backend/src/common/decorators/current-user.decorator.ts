import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtAccessPayload } from '../jwt/jwt-payload.interface';

/**
 * Extracts the authenticated user (JWT access payload) from the request.
 *
 * @example
 *   @Get('me')
 *   me(@CurrentUser() user: JwtAccessPayload) {
 *     return { id: user.sub, roleKey: user.roleKey };
 *   }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtAccessPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as JwtAccessPayload;
  },
);
