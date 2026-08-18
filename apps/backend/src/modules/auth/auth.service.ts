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
 * - `logout`, `me`, `setPin`, `verifyPin` (self-check path), and the
 *   offline-credential endpoints run on the caller's own already-scoped
 *   `request.dbClient` like any other authenticated endpoint.
 * - `verifyPin`'s cross-user case (a kasir submitting a SUPERVISOR's userId
 *   + PIN, FR-POS-03) needs to read a DIFFERENT user's `pin_hash` than the
 *   caller's own — `users_select`'s RLS (central role OR self) would block
 *   that under the caller's own context, so this one lookup also uses
 *   `withSystemContext` on a dedicated connection, matching the documented
 *   pattern.
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
import { JwtService } from '@nestjs/jwt';
import { Pool, PoolClient } from 'pg';
import { compare } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import {
  can,
  ERR_AUTH_INVALID_CREDENTIALS,
  ERR_AUTH_PIN_INVALID,
  ERR_AUTH_TOKEN_INVALID,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  permissionsForRole,
  SyncEntity,
  type LoginRes,
  type Me,
  type OfflineCredentialRes,
  type RoleKey,
} from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { ScopeService } from '../../common/scope/scope.service';
import { TokenService } from '../../common/jwt/token.service';
import { accessSecret } from '../../common/jwt/jwt-secrets';
import type { JwtAccessPayload, JwtRefreshPayload } from '../../common/jwt/jwt-payload.interface';
import {
  assertSystemContext,
  withSystemContext,
  SYSTEM_CENTRAL_ROLE,
} from '../../common/database/system-context';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { AuthRepository } from './auth.repository';
import { OfflineCredentialMintService } from './offline-credential-mint.service';
import { hashPin, verifyPin as verifyPinHash } from './pin-hash.util';
import { parseDurationMs } from './duration.util';
import { hashRefreshToken, verifyRefreshTokenHash } from './token-hash.util';
import type {
  LoginDto,
  OfflineCredentialRefreshDto,
  RefreshDto,
  RevokeCredentialDto,
  SetPinDto,
  VerifyPinDto,
} from './auth.dto';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

const REFRESH_DEFAULT_MS = 7 * 86_400_000;
const VERIFIER_TOKEN_TTL = '5m';

@Injectable()
export class AuthService {
  private readonly verifierJwt: JwtService;

  constructor(
    private readonly repo: AuthRepository,
    private readonly mintService: OfflineCredentialMintService,
    private readonly scope: ScopeService,
    private readonly tokens: TokenService,
    private readonly syncEmit: SyncEmitService,
    private readonly config: ConfigService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {
    this.verifierJwt = new JwtService({
      secret: accessSecret(config),
      signOptions: { expiresIn: VERIFIER_TOKEN_TTL },
    });
  }

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
   * NOT a `request.dbClient` case despite running behind `JwtAuthGuard` +
   * `RlsContextGuard` (this route is `(any)`, not `@Public()`) — deliberately
   * re-examined per the coordinator's cross-module RLS-defect sweep (a
   * service silently querying an unprivileged `this.pool` connection instead
   * of the guard-scoped one, as happened in the supplier module).
   *
   * `context: 'pos_override'` (FR-POS-03) is a genuine CROSS-USER read: the
   * CALLER is a kasir's authenticated session, but `dto.userId` names a
   * DIFFERENT person (the supervisor physically present at the register) —
   * the caller's own `request.dbClient` is scoped to the CALLER's identity
   * (`users_select` RLS: central role OR `app_is_self(id)`), and a kasir is
   * neither central nor the supervisor, so their own dbClient would read
   * ZERO rows for `dto.userId` — not an error, just silently wrong, which is
   * worse than the supplier bug because it wouldn't even throw. This is
   * exactly the kind of legitimate escalation `common/database/system
   * -context.ts` exists for (the SAME central-role bypass an Owner already
   * has, asserted transactionally, never touching the caller's own
   * connection) — reused here via `withSystemContext` rather than the
   * hand-rolled BEGIN/COMMIT `login`/`refresh` need (those also thread a
   * SECOND phase re-scoping to a newly-verified identity; this is a single
   * bypassed read with no further phase, which is exactly what
   * `withSystemContext` is for).
   */
  async verifyPin(
    dto: VerifyPinDto,
  ): Promise<{ ok: true; verifierToken: string; expiresAt: string }> {
    await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      const target = await this.repo.findUserAuthById(client, dto.userId);
      if (!target || !target.is_active || !target.pin_hash) {
        throw new UnauthorizedException({ code: ERR_AUTH_PIN_INVALID, message: 'Invalid PIN' });
      }
      const ok = await verifyPinHash(dto.pin, target.pin_hash);
      if (!ok) {
        throw new UnauthorizedException({ code: ERR_AUTH_PIN_INVALID, message: 'Invalid PIN' });
      }
    });

    const verifierToken = this.verifierJwt.sign({
      sub: dto.userId,
      context: dto.context,
      purpose: 'pin_verified',
    });
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    return { ok: true, verifierToken, expiresAt };
  }

  // ── offline credential lifecycle (D-17) ─────────────────────────────────

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
