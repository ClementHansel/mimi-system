import { ConfigService } from '@nestjs/config';

/**
 * Single source of truth for the env var names/defaults backing the two
 * token families, so `TokenService` (signing) and the two Passport
 * strategies (verifying) can never drift apart.
 */
export function accessSecret(config: ConfigService): string {
  return config.get<string>('JWT_SECRET', 'dev-access-secret-change-me');
}

export function refreshSecret(config: ConfigService): string {
  return config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me');
}
