/**
 * M01 `auth` — CONTRACTS.md §4.1. Login/refresh/logout/me/PIN/offline-credential
 * lifecycle. Session context handling:
 *
 * - `login` and `refresh` are `@Public()` (no user JWT yet), so
 *   `RlsContextGuard` never runs for them and `request.dbClient` does not
 *   exist — this service opens its OWN connection and establishes RLS
 *   context by hand, exactly mirroring `RlsContextGuard`'s own two-phase
 *   pattern (`SET LOCAL ROLE app_user`, `app.user_id`/`app.role` from a
 *   VERIFIED identity, then `ScopeService.resolveLocationIds` for
 *   `app.location_ids`). `login` additionally needs one read BEFORE any
 *   identity is verified (looking a user up by username); for that one
 *   query only it uses the canonical `common/database/system-context.ts`'s
 *   `assertSystemContext({ role: SYSTEM_CENTRAL_ROLE })` — the same
 *   central-role-bypass primitive every system-context caller in this
 *   codebase now shares (read-only import; that file is W1-D's, not
 *   modified here).
 * - `logout`, `me`, `setPin` and the offline-credential endpoints run on the
 *   caller's own already-scoped `request.dbClient` like any other
 *   authenticated endpoint.
 * - There is no longer a cross-user PIN read of any kind. `verifyPin` used to
 *   sit here and reach a DIFFERENT user's `pin_hash` through
 *   `withSystemContext`, which was legitimate as plumbing and fatal as a
 *   feature — it made the endpoint an unthrottled PIN oracle (B-15). It was
 *   deleted rather than fixed; FR-POS-03's "a supervisor authorises at the
 *   till" now runs on one-time approval codes in `kernel/approvals`.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { compare } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import {
  can,
  encodeUnlockCode,
  ERR_AUTH_INVALID_CREDENTIALS,
  ERR_AUTH_TOKEN_INVALID,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  permissionsForRole,
  ROLE_RANK,
  SyncEntity,
  unlockCodeMessage,
  type LoginRes,
  type Me,
  type OfflineCredentialRes,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { ScopeService } from '../../common/scope/scope.service';
import { TokenService } from '../../common/jwt/token.service';
import type { JwtAccessPayload, JwtRefreshPayload } from '../../common/jwt/jwt-payload.interface';
import {
  assertSystemContext,
  SYSTEM_CENTRAL_ROLE,
  withSystemContext,
} from '../../common/database/system-context';
import { decryptBindingSecret, encKeyFromConfig } from '../../kernel/sync/binding-crypto';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { AuthRepository } from './auth.repository';
import { OfflineCredentialMintService } from './offline-credential-mint.service';
import { hashPin } from './pin-hash.util';
import { parseDurationMs } from './duration.util';
import { hashRefreshToken, verifyRefreshTokenHash } from './token-hash.util';
import type {
  LoginDto,
  OfflineCredentialRefreshDto,
  RefreshDto,
  RevokeCredentialDto,
  OfflineUnlockCodeDto,
  SetPinDto,
} from './auth.dto';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

const REFRESH_DEFAULT_MS = 7 * 86_400_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly mintService: OfflineCredentialMintService,
    private readonly scope: ScopeService,
    private readonly tokens: TokenService,
    private readonly syncEmit: SyncEmitService,
    private readonly config: ConfigService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  // ── login ────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, meta: RequestMeta): Promise<LoginRes> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Pre-identity lookup only; narrowed to the real user right below.
      // `assertSystemContext`'s default `userId` (the canonical all-zero
      // sentinel) is what keeps this safe on a pooled connection previously
      // used by an authenticated request — see common/database/system-context.ts.
      await assertSystemContext(client, { role: SYSTEM_CENTRAL_ROLE });

      const user = await this.repo.findUserAuthByUsername(client, dto.username);
      if (!user || !user.is_active) {
        throw new UnauthorizedException({
          code: ERR_AUTH_INVALID_CREDENTIALS,
          message: 'Invalid username or password',
        });
      }
      const passwordOk = await compare(dto.password, user.password_hash);
      if (!passwordOk) {
        throw new UnauthorizedException({
          code: ERR_AUTH_INVALID_CREDENTIALS,
          message: 'Invalid username or password',
        });
      }

      // Re-establish the transaction's RLS context as the now-VERIFIED
      // identity — the same two-phase handshake RlsContextGuard performs on
      // every subsequent request for this user.
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
      await client.query(`SELECT set_config('app.role', $1, true)`, [user.role_key]);
      // THIS user's tenant, not "the only" tenant. Login is the one place that
      // must get this from the identity being authenticated — a shared instance
      // authenticates people from different companies through this same path.
      await client.query(`SELECT set_config('app.tenant_id', app_tenant_of_user($1)::text, true)`, [
        user.id,
      ]);
      const locationScope = await this.scope.resolveLocationIds(client, {
        sub: user.id,
        roleKey: user.role_key,
      });
      await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
        locationScope === null ? '' : locationScope.join(','),
      ]);

      const rawLocationIds = await this.repo.rawLocationIds(client, user.id);
      const locationDetails = await this.repo.locationDetails(client, user.id);
      const employeeId = await this.repo.employeeIdForUser(client, user.id);
      await this.repo.touchLastLogin(client, user.id);

      const accessToken = this.tokens.signAccessToken({
        sub: user.id,
        username: user.username,
        roleKey: user.role_key,
        locationIds: rawLocationIds,
      });

      const sessionId = randomUUID();
      const refreshToken = this.signRefreshTokenUnique(user.id, sessionId);
      const refreshTokenHash = hashRefreshToken(refreshToken);
      const refreshTtlMs = parseDurationMs(
        this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
        REFRESH_DEFAULT_MS,
      );
      await this.repo.insertSession(client, {
        id: sessionId,
        userId: user.id,
        refreshTokenHash,
        deviceId: dto.deviceId ?? null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + refreshTtlMs).toISOString(),
      });

      let offlineCredentials: OfflineCredentialRes[] | undefined;
      if (dto.deviceId && can(user.role_key as RoleKey, 'auth.offline_credential.mint')) {
        const cred = await this.mintService.mint(client, {
          userId: user.id,
          username: user.username,
          roleKey: user.role_key,
          deviceId: dto.deviceId,
          pinHash: user.pin_hash,
          locationIds: rawLocationIds,
        });
        if (cred) offlineCredentials = [cred];
      }

      await client.query('COMMIT');

      const me: Me = {
        id: user.id,
        username: user.username,
        name: user.name,
        roleKey: user.role_key,
        permissions: permissionsForRole(user.role_key as RoleKey),
        locations: locationDetails,
        employeeId,
        mustSetPin: !user.pin_hash,
      };

      return {
        accessToken,
        refreshToken,
        user: me,
        ...(offlineCredentials ? { offlineCredentials } : {}),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── refresh ──────────────────────────────────────────────────────────────

  async refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: JwtRefreshPayload;
    try {
      payload = this.tokens.verifyRefreshToken(dto.refreshToken);
    } catch {
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: 'Invalid or expired refresh token',
      });
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [payload.sub]);
      await client.query(`SELECT set_config('app.location_ids', '', true)`);

      const user = await this.repo.findUserAuthById(client, payload.sub);
      if (!user || !user.is_active) {
        throw new UnauthorizedException({
          code: ERR_AUTH_TOKEN_INVALID,
          message: 'Invalid or expired refresh token',
        });
      }
      await client.query(`SELECT set_config('app.role', $1, true)`, [user.role_key]);
      await client.query(`SELECT set_config('app.tenant_id', app_tenant_of_user($1)::text, true)`, [
        user.id,
      ]);

      const session = await this.repo.findSession(client, payload.sessionId);
      const sessionValid =
        session &&
        session.user_id === user.id &&
        !session.revoked_at &&
        new Date(session.expires_at).getTime() > Date.now();
      if (!session || !sessionValid) {
        throw new UnauthorizedException({
          code: ERR_AUTH_TOKEN_INVALID,
          message: 'Invalid or expired refresh token',
        });
      }

      const tokenOk = verifyRefreshTokenHash(dto.refreshToken, session.refresh_token_hash);
      if (!tokenOk) {
        // Presented token doesn't match this session's stored hash — signature
        // verified but the session moved on (already rotated/reused). Revoke
        // defensively: this pattern (valid signature, stale hash) is exactly
        // what a stolen-and-replayed refresh token looks like.
        await this.repo.revokeSession(client, session.id);
        await client.query('COMMIT');
        throw new UnauthorizedException({
          code: ERR_AUTH_TOKEN_INVALID,
          message: 'Invalid or expired refresh token',
        });
      }

      const rawLocationIds = await this.repo.rawLocationIds(client, user.id);
      const accessToken = this.tokens.signAccessToken({
        sub: user.id,
        username: user.username,
        roleKey: user.role_key,
        locationIds: rawLocationIds,
      });
      const refreshToken = this.signRefreshTokenUnique(user.id, session.id);
      const refreshTokenHash = hashRefreshToken(refreshToken);
      const refreshTtlMs = parseDurationMs(
        this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
        REFRESH_DEFAULT_MS,
      );
      await this.repo.rotateSession(client, session.id, {
        refreshTokenHash,
        expiresAt: new Date(Date.now() + refreshTtlMs).toISOString(),
      });

      await client.query('COMMIT');
      return { accessToken, refreshToken };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── logout ───────────────────────────────────────────────────────────────

  async logout(
    dto: RefreshDto,
    caller: JwtAccessPayload,
    client: PoolClient,
  ): Promise<{ ok: true }> {
    let payload: JwtRefreshPayload;
    try {
      payload = this.tokens.verifyRefreshToken(dto.refreshToken);
    } catch {
      return { ok: true }; // already dead — logout is idempotent, nothing to revoke
    }
    if (payload.sub !== caller.sub) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'refresh token does not belong to the authenticated user',
      });
    }
    await this.repo.revokeSession(client, payload.sessionId);
    return { ok: true };
  }

  // ── me ───────────────────────────────────────────────────────────────────

  async me(caller: JwtAccessPayload, client: PoolClient): Promise<Me> {
    const row = await this.repo.findUserAuthById(client, caller.sub);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    const locations = await this.repo.locationDetails(client, caller.sub);
    const employeeId = await this.repo.employeeIdForUser(client, caller.sub);
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      roleKey: row.role_key,
      permissions: permissionsForRole(row.role_key as RoleKey),
      locations,
      employeeId,
      mustSetPin: !row.pin_hash,
    };
  }

  // ── PIN set / verify ─────────────────────────────────────────────────────

  async setPin(
    dto: SetPinDto,
    caller: JwtAccessPayload,
    client: PoolClient,
  ): Promise<{ ok: true }> {
    const row = await this.repo.findUserAuthById(client, caller.sub);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    const passwordOk = await compare(dto.currentPassword, row.password_hash);
    if (!passwordOk) {
      throw new UnauthorizedException({
        code: ERR_AUTH_INVALID_CREDENTIALS,
        message: 'Current password is incorrect',
      });
    }
    const pinHash = await hashPin(dto.pin);
    await this.repo.updatePinHash(client, caller.sub, pinHash);

    const locationIds = await this.repo.rawLocationIds(client, caller.sub);
    await this.emitUsersSyncEvent(client, {
      op: 'pin_rotated',
      userId: caller.sub,
      actorUserId: caller.sub,
      locationIds,
    });

    return { ok: true };
  }

  /**
   * `verifyPin` USED TO LIVE HERE, and its deletion is the fix for B-15.
   *
   * It accepted an arbitrary `userId`, read that user under a central RLS
   * bypass, and returned whether a submitted 6-digit PIN was correct — with no
   * rate limit, no lockout and no audit row. Any authenticated caller could
   * brute-force any other account's PIN, and because `offline_credentials
   * .pin_verifier` is minted from the same `users.pin_hash`, what leaked was
   * the credential that authorises voids and discounts on an offline tablet.
   *
   * The owner's decision (Q0=C / Q8, 2026-08-22) was not to rate-limit it but
   * to remove the standing secret it exposed. Its job — "let the till prove a
   * supervisor authorised this" — is now done by
   * `POST /api/approvals/:documentType/:documentId/code`: the approver
   * authorises from their own session and gets a ONE-TIME code, single-use,
   * bound to one document, valid five minutes, with the caller (never the
   * approver) locked out after five wrong tries. See
   * `kernel/approvals/approval-code.service.ts`.
   *
   * Nothing consumed the `pin_verified` token this used to mint, so nothing
   * broke by deleting it. Do not reintroduce a "check this user's PIN"
   * endpoint: there is no shape of it that is not an oracle.
   */

  // ── offline credential lifecycle (D-17) ─────────────────────────────────

  /**
   * B-17 — mints the code that unlocks a credential a tablet has locked out,
   * for a supervisor who is standing in an outlet with no internet.
   *
   * ## Why this exists at all
   *
   * Five wrong PINs on a device locks the cached credential. Online that is
   * recoverable by re-issuing the credential; OFFLINE it used to mean that
   * supervisor could not authorise anything for the rest of the outage — during
   * exactly the conditions offline-first exists for. The recovery channel is the
   * one an isolated outlet still has: a phone call to head office.
   *
   * The tablet shows a 6-digit challenge, someone here types it in, and the
   * 8-character answer this returns is read back down the line. The device
   * verifies it against the binding secret it already holds, with no
   * connectivity at any point.
   *
   * ## What actually authorises the caller
   *
   * `auth.lockout.clear` gets them to this method. What decides it is the same
   * rule as the online unlock (owner Q6): the caller must STRICTLY outrank the
   * credential's owner by `ROLE_RANK`. A supervisor frees a kasir; nobody frees
   * a peer. The owner's role is read from the database, never taken from the
   * request, because a caller-supplied role would make the check bypassable by
   * the one person it constrains.
   *
   * ## What this deliberately cannot reach
   *
   * `findCredentialForUnlock` goes through migration 206's SECURITY DEFINER
   * function, which returns `user_id` and `binding_secret_enc` and CANNOT return
   * `pin_verifier`. So the offline recovery path never gives a central role an
   * argon2id hash of somebody's PIN — which would have been a step back toward
   * B-15, the blocker this work just closed.
   */
  async issueOfflineUnlockCode(
    credentialId: UUID,
    dto: OfflineUnlockCodeDto,
    caller: JwtAccessPayload,
    client: PoolClient,
  ): Promise<{ code: string; credentialId: UUID }> {
    const cred = await this.repo.findCredentialForUnlock(client, credentialId);
    if (!cred) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Credential not found' });
    }
    if (cred.revokedAt) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'This credential was revoked. Issue a new one instead of unlocking it.',
      });
    }

    // The owner's role goes through a SYSTEM context, not the caller's client.
    // `users_select` is central-or-self, so a SUPERVISOR unlocking a KASIR — the
    // primary case this feature exists for — reads zero rows on their own
    // connection and the whole thing fails with a misleading "owner not found".
    // Caught by the test below that asserts a supervisor CAN unlock a kasir; the
    // rank check itself is unchanged and still decides the outcome.
    const ownerRole = await withSystemContext(
      this.pool,
      { role: SYSTEM_CENTRAL_ROLE },
      (systemClient) => this.repo.findRoleKeyByUserId(systemClient, cred.userId as UUID),
    );
    if (!ownerRole) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Credential owner not found' });
    }
    const callerRank = ROLE_RANK[caller.roleKey as RoleKey] ?? 0;
    const ownerRank = ROLE_RANK[ownerRole as RoleKey] ?? 0;
    if (callerRank <= ownerRank) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message:
          'Only someone of higher authority than the credential holder may unlock it. Escalate to a manager.',
      });
    }

    const k = decryptBindingSecret(cred.bindingSecretEnc, encKeyFromConfig(this.config));
    // The message and the encoding come from `@mimi/shared` so the device
    // derives the identical code. Defining either of them twice is how the
    // §7.3 binding HMAC ended up with two different joiner characters and broke
    // every offline approval silently — see that fixture's header.
    const hex = createHmac('sha256', k)
      .update(unlockCodeMessage(credentialId, dto.challenge), 'utf8')
      .digest('hex');

    return { code: encodeUnlockCode(hex), credentialId };
  }

  async refreshOfflineCredential(
    dto: OfflineCredentialRefreshDto,
    caller: JwtAccessPayload,
    client: PoolClient,
  ): Promise<OfflineCredentialRes> {
    const row = await this.repo.findUserAuthById(client, caller.sub);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    const locationIds = await this.repo.rawLocationIds(client, caller.sub);
    const cred = await this.mintService.mint(client, {
      userId: caller.sub,
      username: row.username,
      roleKey: row.role_key,
      deviceId: dto.deviceId,
      pinHash: row.pin_hash,
      locationIds,
    });
    if (!cred) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message:
          'This role holds no offline-eligible approval scope, or the PIN has not been set yet (POST /api/auth/pin first)',
      });
    }
    return cred;
  }

  async revokeOfflineCredential(
    credentialId: string,
    dto: RevokeCredentialDto,
    caller: JwtAccessPayload,
    client: PoolClient,
  ): Promise<{ ok: true }> {
    const cred = await this.repo.findOfflineCredential(client, credentialId);
    if (!cred)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Offline credential not found' });

    const isOwn = cred.user_id === caller.sub;
    if (!isOwn && !can(caller.roleKey as RoleKey, 'user.update')) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: "Cannot revoke another user's offline credential",
      });
    }

    await this.repo.revokeOfflineCredential(client, credentialId);

    const locationIds = cred.location_ids.length > 0 ? cred.location_ids : [null];
    for (const locationId of locationIds) {
      await this.syncEmit.emit(client, {
        entity: SyncEntity.OFFLINE_AUTHORIZATIONS,
        op: 'revoked',
        entityId: credentialId,
        locationId,
        actorUserId: caller.sub,
        data: { credentialId, reason: dto.reason },
      });
    }

    return { ok: true };
  }

  /** Shared with `UsersModule` conceptually (one event per assigned location — §3.2/§3.3 `users` pull scope is `own_location`); central roles with no `user_locations` rows emit nothing (no location-scoped device needs to cache their row). */
  private async emitUsersSyncEvent(
    client: PoolClient,
    params: {
      op: 'created' | 'updated' | 'deactivated' | 'pin_rotated';
      userId: string;
      actorUserId: string;
      locationIds: string[];
    },
  ): Promise<void> {
    for (const locationId of params.locationIds) {
      await this.syncEmit.emit(client, {
        entity: SyncEntity.USERS,
        op: params.op,
        entityId: params.userId,
        locationId,
        actorUserId: params.actorUserId,
        data: { userId: params.userId },
      });
    }
  }

  /**
   * `TokenService.signRefreshToken` signs exactly `{sub, sessionId}`
   * (`JwtRefreshPayload`, `common/jwt/jwt-payload.interface.ts` — frozen,
   * not this agent's to widen). `jsonwebtoken`'s `iat` claim has ONLY
   * second-granularity, so two refresh tokens for the SAME session signed
   * within the same wall-clock second — e.g. `login()` immediately followed
   * by `refresh()`, exactly what a test (or a real double-tap) does — would
   * otherwise serialize to the BYTE-IDENTICAL string, silently defeating
   * rotation (the "new" token wouldn't actually invalidate the "old" one,
   * since they're the same string). A random `jti` is added via a
   * variable-typed cast (TS excess-property checks only fire on object
   * LITERALS passed directly to a typed parameter, not on a pre-typed
   * variable) so `TokenService`'s own typed surface never needs to change.
   */
  private signRefreshTokenUnique(sub: string, sessionId: string): string {
    const payload = { sub, sessionId, jti: randomUUID() } as unknown as JwtRefreshPayload;
    return this.tokens.signRefreshToken(payload);
  }
}
