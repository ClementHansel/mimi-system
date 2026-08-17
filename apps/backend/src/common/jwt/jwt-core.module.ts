import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TokenService } from './token.service';
import { JwtAccessStrategy } from './jwt-access.strategy';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';

/**
 * Global JWT core: registers both Passport strategies ('jwt', 'jwt-refresh')
 * and exposes `TokenService` so M01 `auth` (Wave 3) can sign tokens at
 * login/refresh without redefining secret handling. Frozen after G1 like
 * every other `common/**` file (BUILD-PLAN §6 rule 2/4).
 */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [TokenService, JwtAccessStrategy, JwtRefreshStrategy],
  exports: [TokenService],
})
export class JwtCoreModule {}
