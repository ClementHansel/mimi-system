import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtAccessPayload } from './jwt-payload.interface';
import { accessSecret } from './jwt-secrets';

/**
 * Validates the `Authorization: Bearer <accessToken>` header on every
 * protected route. Registered as Passport strategy `'jwt'` — `JwtAuthGuard`
 * (`AuthGuard('jwt')`) is what actually gates requests; this strategy only
 * decodes+verifies and hands back the payload as `request.user`.
 */
@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: accessSecret(config),
    });
  }

  validate(payload: JwtAccessPayload): JwtAccessPayload {
    return payload;
  }
}
