/**
 * Constructs real service graphs against the live `mimi_app` pool for
 * integration tests — mirrors `kernel/approvals/test-support`'s
 * `new ApprovalService(new ApprovalsRepository())` pattern (no NestJS
 * `TestingModule`, just plain `new`, since none of these classes take
 * anything but plain constructor args).
 */
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { ScopeService } from '../../../common/scope/scope.service';
import { TokenService } from '../../../common/jwt/token.service';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { AuthRepository } from '../auth.repository';
import { AuthService } from '../auth.service';
import { OfflineCredentialMintService } from '../offline-credential-mint.service';

export function buildConfigService(overrides: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    JWT_SECRET: 'test-access-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '7d',
    OFFLINE_CREDENTIAL_ENC_KEY: '11'.repeat(32),
    ...overrides,
  });
}

export function buildSyncEmit(pool: Pool): SyncEmitService {
  const events = new SyncEventsRepository(pool);
  return new SyncEmitService(events, new ConflictDetectorService(events, new SyncConflictsRepository()));
}

export function buildAuthService(pool: Pool, config: ConfigService = buildConfigService()): AuthService {
  return new AuthService(
    new AuthRepository(),
    new OfflineCredentialMintService(new AuthRepository(), config),
    new ScopeService(),
    new TokenService(config),
    buildSyncEmit(pool),
    config,
    pool,
  );
}
