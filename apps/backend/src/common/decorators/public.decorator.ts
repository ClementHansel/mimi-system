import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';

/**
 * Marks a route as not requiring an access token. Checked by the global
 * `JwtAuthGuard` and `RlsContextGuard` (a public route has no `request.user`
 * to build an RLS context from). Use on `/api/auth/login`, the `/health`
 * endpoint, and any other route CONTRACTS.md marks **(public)**.
 *
 * @example
 *   @Public()
 *   @Post('login')
 *   login(@Body() dto: LoginDto) { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
