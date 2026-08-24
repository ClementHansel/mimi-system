import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SyncEntity, type Paginated, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { getDefaultGeofenceRadiusM } from '../hr/hr-settings.util';
import { withWrite } from './db-tx';
import { CreateLocationDto, ListLocationsQueryDto, UpdateLocationDto } from './dto/location.dto';

export interface LocationRow {
  id: string;
  code: string;
  name: string;
  type: string;
  city: string;
  address: string | null;
  phone: string | null;
  latitude: string | null;
  longitude: string | null;
  geofence_radius_m: number | null;
  is_active: boolean;
  storage_area_count: string;
}

export interface Location {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet' | 'office';
  city: string;
  address: string | null;
  phone: string | null;
  latitude: string | null;
  longitude: string | null;
  /**
   * EFFECTIVE radius in metres: this location's own value, or the
   * `hr.geofence_radius_m` default when it has none (migration 229). Resolved
   * before the row leaves the API so no client has to know about the fallback —
   * the Absen screen must measure against exactly what check-in enforces.
   */
  geofenceRadiusM: number;
  /** True when this location overrides the default rather than inheriting it. */
  geofenceRadiusIsOverride: boolean;
  isActive: boolean;
  storageAreaCount: number;
}

/**
 * M03 `location` — outlets + gudang pusat (CONTRACTS.md §4.3). `locations` is
 * THE scoping dimension (D-05) and is RLS-enforced (§1.14: read `ALL`, write
 * `ROLE(owner,manager)`) — every query below runs on the caller-supplied
 * `PoolClient` (the same one `RlsContextGuard` opened for this request), never
 * on a fresh `DATABASE_POOL` connection (see `request-db-client.ts`).
 */
@Injectable()
export class LocationService {
  constructor(private readonly sync: SyncEmitService) {}

  /**
   * Resolves each row's EFFECTIVE geofence radius before it leaves the API.
   *
   * `geofence_radius_m` is nullable (migration 229) — NULL means "inherit
   * `hr.geofence_radius_m`". Clients must never have to know that: the Absen
   * screen measures the employee's distance against this number, so if it
   * arrived as null the phone would either show no fence or fall back to a
   * hardcoded guess, and the two sides would disagree about whether someone is
   * at work. `geofenceRadiusIsOverride` keeps the distinction available for the
   * one screen that genuinely needs it (Admin's location editor).
   */
  private map(row: LocationRow, defaultRadiusM: number): Location {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as 'warehouse' | 'outlet' | 'office',
      city: row.city,
      address: row.address,
      phone: row.phone,
      latitude: row.latitude,
      longitude: row.longitude,
      geofenceRadiusM: row.geofence_radius_m ?? defaultRadiusM,
      geofenceRadiusIsOverride: row.geofence_radius_m !== null,
      isActive: row.is_active,
      storageAreaCount: parseInt(row.storage_area_count, 10),
    };
  }

  private readonly baseSelect = `
    SELECT l.id, l.code, l.name, l.type, l.city, l.address, l.phone, l.latitude, l.longitude,
           l.geofence_radius_m, l.is_active,
           (SELECT COUNT(*) FROM storage_areas sa WHERE sa.location_id = l.id AND sa.is_active = true) AS storage_area_count
    FROM locations l`;

  async list(client: PoolClient, query: ListLocationsQueryDto): Promise<Paginated<Location>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.type) {
      params.push(query.type);
      where.push(`l.type = $${params.length}`);
    }
    if (query.city) {
      params.push(query.city);
      where.push(`l.city = $${params.length}`);
    }
    if (query.active !== undefined) {
      params.push(query.active);
      where.push(`l.is_active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM locations l ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]!.count, 10);

    params.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await client.query<LocationRow>(
      `${this.baseSelect} ${whereSql} ORDER BY l.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const defaultRadiusM = await getDefaultGeofenceRadiusM(client);
    return {
      rows: rowsRes.rows.map((r) => this.map(r, defaultRadiusM)),
      total,
      page,
      pageSize,
    };
  }

  /** The 4 Kalimantan cities (FR-LOG-01) — distinct, non-null, from active locations. */
  async listCities(client: PoolClient): Promise<string[]> {
    const res = await client.query<{ city: string }>(
      `SELECT DISTINCT city FROM locations WHERE is_active = true ORDER BY city ASC`,
    );
    return res.rows.map((r) => r.city);
  }

  async getById(client: PoolClient, id: string): Promise<Location> {
    const res = await client.query<LocationRow>(`${this.baseSelect} WHERE l.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Location not found' });
    return this.map(res.rows[0], await getDefaultGeofenceRadiusM(client));
  }

  async create(client: PoolClient, dto: CreateLocationDto, actorUserId: string): Promise<Location> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: string }>(
        // NULL, not COALESCE(..., 100): an omitted radius means "inherit
        // `hr.geofence_radius_m`" (migration 229), and baking 100 in here would
        // silently give every new outlet a permanent override at the old value.
        `INSERT INTO locations (code, name, type, city, address, phone, latitude, longitude, geofence_radius_m)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          dto.code,
          dto.name,
          dto.type,
          dto.city,
          dto.address ?? null,
          dto.phone ?? null,
          dto.latitude ?? null,
          dto.longitude ?? null,
          dto.geofenceRadiusM ?? null,
        ],
      );
      const id = res.rows[0]!.id;
      const location = await this.getById(client, id);
      await this.sync.emit(client, {
        entity: SyncEntity.LOCATIONS,
        op: 'created',
        entityId: id,
        locationId: null,
        actorUserId,
        data: location,
      });
      return location;
    });
  }

  async update(
    client: PoolClient,
    id: string,
    dto: UpdateLocationDto,
    actorUserId: string,
  ): Promise<Location> {
    return withWrite(client, async () => {
      // `code` is IMMUTABLE once created (CONTRACTS.md §4.3): it appears in
      // Surat Jalan and receipt document numbers, so changing it after the
      // fact would orphan every already-printed document's reference. The
      // field stays on `UpdateLocationDto` (whitelisted) so an edit form that
      // echoes the location's own unchanged code back in its PATCH body — the
      // normal case — is not rejected outright; only an ACTUAL change is.
      if (dto.code !== undefined) {
        const current = await this.getById(client, id);
        if (dto.code !== current.code) {
          throw new BadRequestException({
            code: 'ERR_LOCATION_CODE_IMMUTABLE',
            message: 'Location code cannot be changed after creation',
          });
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.type !== undefined) set('type', dto.type);
      if (dto.city !== undefined) set('city', dto.city);
      if (dto.address !== undefined) set('address', dto.address);
      if (dto.phone !== undefined) set('phone', dto.phone);
      if (dto.latitude !== undefined) set('latitude', dto.latitude);
      if (dto.longitude !== undefined) set('longitude', dto.longitude);
      if (dto.geofenceRadiusM !== undefined) set('geofence_radius_m', dto.geofenceRadiusM);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(
          `UPDATE locations SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
        if (res.rowCount === 0)
          throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Location not found' });
      } else {
        await this.getById(client, id); // 404 if missing, otherwise no-op update
      }

      const location = await this.getById(client, id);
      await this.sync.emit(client, {
        entity: SyncEntity.LOCATIONS,
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: location,
      });
      return location;
    });
  }

  async deactivate(
    client: PoolClient,
    id: string,
    actorUserId: string,
  ): Promise<{ id: string; deactivated: true }> {
    return withWrite(client, async () => {
      const res = await client.query(`UPDATE locations SET is_active = false WHERE id = $1`, [id]);
      if (res.rowCount === 0)
        throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: 'Location not found' });
      await this.sync.emit(client, {
        entity: SyncEntity.LOCATIONS,
        op: 'deactivated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: { id, deactivated: true },
      });
      return { id, deactivated: true };
    });
  }
}
