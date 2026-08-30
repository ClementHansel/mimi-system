/**
 * Raw `pg` access for M02 `users` (CONTRACTS.md §4.2). Parameterized queries
 * only. Every method takes the caller's `PoolClient`.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Paginated, UUID, UserRow } from '@mimi/shared';

export interface UsersListFilter {
  q?: string;
  roleKey?: string;
  locationId?: string;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

interface UserDetailRawRow {
  id: UUID;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  role_key: string;
  role_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

@Injectable()
export class UsersRepository {
  async list(client: PoolClient, filter: UsersListFilter): Promise<Paginated<UserRow>> {
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 200) : 50;

    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('$$', `$${params.length}`));
    };

    if (filter.q) {
      params.push(`%${filter.q}%`);
      const idx = params.length;
      conditions.push(`(u.username ILIKE $${idx} OR u.name ILIKE $${idx})`);
    }
    if (filter.roleKey) push(`r.key = $$`, filter.roleKey);
    if (filter.active !== undefined) push(`u.is_active = $$`, filter.active);
    if (filter.locationId)
      push(
        `EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = $$)`,
        filter.locationId,
      );

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users u JOIN roles r ON r.id = u.role_id ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rowsRes = await client.query<UserDetailRawRow>(
      `SELECT u.id, u.username, u.name, u.email, u.phone, r.key AS role_key, r.name AS role_name,
              u.is_active, u.last_login_at, u.created_at
         FROM users u JOIN roles r ON r.id = u.role_id
         ${where}
        ORDER BY u.name
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const rows = await this.hydrateLocations(client, rowsRes.rows);
    return { rows, total, page, pageSize };
  }

  async findById(client: PoolClient, id: UUID): Promise<UserRow | undefined> {
    const res = await client.query<UserDetailRawRow>(
      `SELECT u.id, u.username, u.name, u.email, u.phone, r.key AS role_key, r.name AS role_name,
              u.is_active, u.last_login_at, u.created_at
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [id],
    );
    if (!res.rows[0]) return undefined;
    const [row] = await this.hydrateLocations(client, res.rows);
    return row;
  }

  private async hydrateLocations(client: PoolClient, rows: UserDetailRawRow[]): Promise<UserRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const locRes = await client.query<{ user_id: UUID; id: UUID; name: string }>(
      `SELECT ul.user_id, l.id, l.name
         FROM user_locations ul JOIN locations l ON l.id = ul.location_id
        WHERE ul.user_id = ANY($1::uuid[])
        ORDER BY l.name`,
      [ids],
    );
    const byUser = new Map<UUID, { id: UUID; name: string }[]>();
    for (const r of locRes.rows) {
      const list = byUser.get(r.user_id) ?? [];
      list.push({ id: r.id, name: r.name });
      byUser.set(r.user_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      email: r.email,
      phone: r.phone,
      roleKey: r.role_key,
      roleName: r.role_name,
      locations: byUser.get(r.id) ?? [],
      isActive: r.is_active,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
    }));
  }

  async findRoleByKey(
    client: PoolClient,
    key: string,
  ): Promise<{ id: UUID; key: string; retiredAt: string | null } | undefined> {
    // `retired_at` comes back so the caller can refuse to GRANT a decommissioned
    // role (migration 237). The row itself stays readable: history references
    // retired roles, and a lookup that hid them would make past approvals
    // unnameable.
    const res = await client.query<{ id: UUID; key: string; retired_at: string | null }>(
      `SELECT id, key, retired_at FROM roles WHERE key = $1`,
      [key],
    );
    const row = res.rows[0];
    return row ? { id: row.id, key: row.key, retiredAt: row.retired_at } : undefined;
  }

  async usernameTaken(client: PoolClient, username: string): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM users WHERE username = $1`, [username]);
    return (res.rowCount ?? 0) > 0;
  }

  async insertUser(
    client: PoolClient,
    row: {
      username: string;
      name: string;
      email: string | null;
      phone: string | null;
      passwordHash: string;
      roleId: UUID;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      // `tenant_id` comes from the SESSION, never from the caller's payload —
      // a create endpoint that accepted a tenant would let an owner mint users
      // into another company. `current_setting` is what RlsContextGuard set
      // from this user's own row, so a new user always lands in the creator's
      // tenant and nowhere else.
      `INSERT INTO users (username, name, email, phone, password_hash, role_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6, current_setting('app.tenant_id')::uuid) RETURNING id`,
      [row.username, row.name, row.email, row.phone, row.passwordHash, row.roleId],
    );
    return res.rows[0]!.id;
  }

  async updateProfile(
    client: PoolClient,
    id: UUID,
    patch: { name?: string; email?: string | null; phone?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.email !== undefined) set('email', patch.email);
    if (patch.phone !== undefined) set('phone', patch.phone);
    if (sets.length === 0) return;
    params.push(id);
    await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }

  async updateRole(client: PoolClient, id: UUID, roleId: UUID): Promise<void> {
    await client.query(`UPDATE users SET role_id = $2 WHERE id = $1`, [id, roleId]);
  }

  async updatePasswordHash(client: PoolClient, id: UUID, passwordHash: string): Promise<void> {
    await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  }

  async deactivate(client: PoolClient, id: UUID): Promise<void> {
    await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
  }

  async currentLocationIds(client: PoolClient, userId: UUID): Promise<UUID[]> {
    const res = await client.query<{ location_id: UUID }>(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((r) => r.location_id);
  }

  async setLocations(client: PoolClient, userId: UUID, add: UUID[], remove: UUID[]): Promise<void> {
    if (remove.length > 0) {
      await client.query(
        `DELETE FROM user_locations WHERE user_id = $1 AND location_id = ANY($2::uuid[])`,
        [userId, remove],
      );
    }
    for (const locationId of add) {
      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, locationId],
      );
    }
  }

  async revokeAllSessions(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async revokeAllOfflineCredentials(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(
      `UPDATE offline_credentials SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async listRoles(client: PoolClient): Promise<{ key: string; name: string }[]> {
    const res = await client.query<{ key: string; name: string }>(
      `SELECT key, name FROM roles ORDER BY name`,
    );
    return res.rows;
  }
}
