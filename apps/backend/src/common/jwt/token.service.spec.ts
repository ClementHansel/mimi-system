import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const config = new ConfigService({
    JWT_SECRET: 'test-access-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '30d',
  });

  it('signs and verifies an access token round-trip', () => {
    const service = new TokenService(config);
    const payload = { sub: 'user-1', username: 'kasir1', roleKey: 'kasir', locationIds: ['loc-1'] };
    const token = service.signAccessToken(payload);
    const verified = service.verifyAccessToken(token);
    expect(verified.sub).toBe('user-1');
    expect(verified.roleKey).toBe('kasir');
    expect(verified.locationIds).toEqual(['loc-1']);
  });

  it('signs and verifies a refresh token round-trip', () => {
    const service = new TokenService(config);
    const token = service.signRefreshToken({ sub: 'user-1', sessionId: 'session-1' });
    const verified = service.verifyRefreshToken(token);
    expect(verified.sub).toBe('user-1');
    expect(verified.sessionId).toBe('session-1');
  });

  it('rejects an access token when verified against the refresh secret (families never cross)', () => {
    const service = new TokenService(config);
    const accessToken = service.signAccessToken({
      sub: 'user-1',
      username: 'x',
      roleKey: 'kasir',
      locationIds: [],
    });
    expect(() => service.verifyRefreshToken(accessToken)).toThrow();
  });
});
