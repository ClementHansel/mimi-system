import { Module } from '@nestjs/common';
import { AuthLockoutModule } from '../../kernel/auth-lockout/auth-lockout.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { OfflineCredentialMintService } from './offline-credential-mint.service';

/**
 * M01 `auth` — owned by Wave 3, agent W3-01 (senior-be).
 *
 * Login, JWT issuance (via `common/jwt`'s `TokenService`), refresh, PIN
 * SET (D-17 offline credentials), and — since B-15 — the lockout unlock path.
 * PIN *verification* is gone: `POST /auth/pin/verify` was the oracle, and the
 * flow it served now runs on one-time approval codes in `kernel/approvals`.
 * CONTRACTS.md §4.1.
 *
 * Imports `SyncEngineModule` (kernel/sync, W2-D) for `SyncEmitService`
 * (collision rule 6 — every mutation emits a sync event) and, read-only, for
 * `assertSystemContext`/`kernel/sync/binding-crypto`'s crypto helpers — see
 * those files' own coordination-note comments for why M01 is their
 * documented consumer.
 */
@Module({
  imports: [SyncEngineModule, AuthLockoutModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, OfflineCredentialMintService],
})
export class AuthModule {}
