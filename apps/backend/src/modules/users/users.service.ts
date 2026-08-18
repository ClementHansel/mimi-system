/**
 * M02 `users` — CONTRACTS.md §4.2. All writes to `users`/`user_locations`
 * are `ROLE(owner,manager)`-only per the RLS matrix (§1.14) — `PermissionsGuard`
 * (owner.create/user.update/etc, all owner+manager per RBAC) is never the
 * only gate here; RLS enforces it independently even if a route were ever
 * mis-annotated.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash as bcryptHash } from 'bcrypt';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  permissionsForRole,
  ROLE_RANK,
  SyncEntity,
  type Paginated,
  type RoleKey,
  type UserRow,
} from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { UsersRepository, type UsersListFilter } from './users.repository';
import type {
  AssignLocationsDto,
  AssignRoleDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
  UpdateUserDto,
} from './users.dto';
import { withWrite } from './db-tx';

const PASSWORD_BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async list(query: ListUsersQueryDto, client: PoolClient): Promise<Paginated<UserRow>> {
    const filter: UsersListFilter = {
      q: query.q,
      roleKey: query.roleKey,
      locationId: query.locationId,
      active: query.active === undefined ? undefined : query.active === 'true',
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    };
    return this.repo.list(client, filter);
  }

  async getOne(id: string, client: PoolClient): Promise<UserRow> {
    const row = await this.repo.findById(client, id);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    return row;
  }

  async create(
    dto: CreateUserDto,
    caller: { roleKey: string; sub: string },
    client: PoolClient,
  ): Promise<UserRow> {
    this.assertCanGrantRole(caller.roleKey, dto.roleKey);

    if (await this.repo.usernameTaken(client, dto.username)) {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: `username '${dto.username}' is already taken`,
      });
    }
    const role = await this.repo.findRoleByKey(client, dto.roleKey);
    if (!role)
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `unknown role '${dto.roleKey}'`,
      });

    return withWrite(client, async () => {
      const passwordHash = await bcryptHash(dto.password, PASSWORD_BCRYPT_ROUNDS);
      const userId = await this.repo.insertUser(client, {
        username: dto.username,
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        passwordHash,
        roleId: role.id,
      });
      await this.repo.setLocations(client, userId, dto.locationIds, []);

      await this.emitUsersEvent(client, 'created', userId, caller.sub, dto.locationIds);
      for (const locationId of dto.locationIds) {
        await this.syncEmit.emit(client, {
          entity: SyncEntity.USER_LOCATIONS,
          op: 'assigned',
          entityId: userId,
          locationId,
          actorUserId: caller.sub,
          data: { userId, locationId },
        });
      }

      return this.getOne(userId, client);
    });
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    caller: { sub: string },
    client: PoolClient,
  ): Promise<UserRow> {
    await this.assertExists(id, client);
    return withWrite(client, async () => {
      await this.repo.updateProfile(client, id, dto);
      const locationIds = await this.repo.currentLocationIds(client, id);
      await this.emitUsersEvent(client, 'updated', id, caller.sub, locationIds);
      return this.getOne(id, client);
    });
  }

  /** "cannot assign a role ranked ≥ caller's" (CONTRACTS.md §4.2) — `ROLE_RANK` (`@mimi/shared`), higher number = broader authority. */
  async assignRole(
    id: string,
    dto: AssignRoleDto,
    caller: { roleKey: string; sub: string },
    client: PoolClient,
  ): Promise<UserRow> {
    await this.assertExists(id, client);
    this.assertCanGrantRole(caller.roleKey, dto.roleKey);

    const role = await this.repo.findRoleByKey(client, dto.roleKey);
    if (!role)
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `unknown role '${dto.roleKey}'`,
      });

    return withWrite(client, async () => {
      await this.repo.updateRole(client, id, role.id);
      const locationIds = await this.repo.currentLocationIds(client, id);
      await this.emitUsersEvent(client, 'updated', id, caller.sub, locationIds);
      return this.getOne(id, client);
    });
  }

  async assignLocations(
    id: string,
    dto: AssignLocationsDto,
    caller: { sub: string },
    client: PoolClient,
  ): Promise<UserRow> {
    await this.assertExists(id, client);
    const before = new Set(await this.repo.currentLocationIds(client, id));
    const after = new Set(dto.locationIds);
    const add = dto.locationIds.filter((locId) => !before.has(locId));
    const remove = [...before].filter((locId) => !after.has(locId));

    return withWrite(client, async () => {
      await this.repo.setLocations(client, id, add, remove);

      for (const locationId of add) {
        await this.syncEmit.emit(client, {
          entity: SyncEntity.USER_LOCATIONS,
          op: 'assigned',
          entityId: id,
          locationId,
          actorUserId: caller.sub,
          data: { userId: id, locationId },
        });
      }
      for (const locationId of remove) {
        await this.syncEmit.emit(client, {
          entity: SyncEntity.USER_LOCATIONS,
          op: 'revoked',
          entityId: id,
          locationId,
          actorUserId: caller.sub,
          data: { userId: id, locationId },
        });
      }

      return this.getOne(id, client);
    });
  }

  async resetPassword(
    id: string,
    dto: ResetPasswordDto,
    client: PoolClient,
  ): Promise<{ ok: true }> {
    await this.assertExists(id, client);
    return withWrite(client, async () => {
      const passwordHash = await bcryptHash(dto.newPassword, PASSWORD_BCRYPT_ROUNDS);
      await this.repo.updatePasswordHash(client, id, passwordHash);
      // Password hash is never part of any device pull projection (§3.2) — no
      // sync event needed. Revoking sessions is the actual security action.
      await this.repo.revokeAllSessions(client, id);
      return { ok: true };
    });
  }

  async deactivate(
    id: string,
    caller: { sub: string },
    client: PoolClient,
  ): Promise<{ id: string; deactivated: true }> {
    await this.assertExists(id, client);
    return withWrite(client, async () => {
      const locationIds = await this.repo.currentLocationIds(client, id);
      await this.repo.deactivate(client, id);
      await this.repo.revokeAllSessions(client, id);
      await this.repo.revokeAllOfflineCredentials(client, id);
      await this.emitUsersEvent(client, 'deactivated', id, caller.sub, locationIds);
      return { id, deactivated: true };
    });
  }

  async listRoles(
    client: PoolClient,
  ): Promise<{ key: string; name: string; permissions: string[] }[]> {
    const rows = await this.repo.listRoles(client);
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      permissions: permissionsForRole(r.key as RoleKey),
    }));
  }

  private assertCanGrantRole(callerRoleKey: string, targetRoleKey: string): void {
    const callerRank = ROLE_RANK[callerRoleKey as RoleKey] ?? 0;
    const targetRank = ROLE_RANK[targetRoleKey as RoleKey] ?? 0;
    if (targetRank >= callerRank) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `cannot assign a role ('${targetRoleKey}') ranked at or above your own ('${callerRoleKey}')`,
      });
    }
  }

  private async assertExists(id: string, client: PoolClient): Promise<void> {
    const row = await this.repo.findById(client, id);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
  }

  private async emitUsersEvent(
    client: PoolClient,
    op: 'created' | 'updated' | 'deactivated',
    userId: string,
    actorUserId: string,
    locationIds: string[],
  ): Promise<void> {
    for (const locationId of locationIds) {
      await this.syncEmit.emit(client, {
        entity: SyncEntity.USERS,
        op,
        entityId: userId,
        locationId,
        actorUserId,
        data: { userId },
      });
    }
  }
}
