import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { withWrite } from '../db-tx';
import { CreateDriverDto, CreateVehicleDto, UpdateDriverDto, UpdateVehicleDto } from '../dto/driver-vehicle.dto';

export interface DriverDto {
  id: UUID;
  name: string;
  phone: string | null;
  licenseNumber: string | null;
  userId: UUID | null;
  isActive: boolean;
}

export interface VehicleDto {
  id: UUID;
  plateNumber: string;
  type: string;
  hasFreezer: boolean;
  isActive: boolean;
}

function mapDriver(r: Record<string, any>): DriverDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    licenseNumber: r.license_number,
    userId: r.user_id,
    isActive: r.is_active,
  };
}

function mapVehicle(r: Record<string, any>): VehicleDto {
  return {
    id: r.id,
    plateNumber: r.plate_number,
    type: r.type,
    hasFreezer: r.has_freezer,
    isActive: r.is_active,
  };
}

/** D-14 master data: `drivers` (RLS `SELECT` policy) and `vehicles` (no RLS — API-gated, migration 037). */
@Injectable()
export class DriverVehicleService {
  constructor(private readonly syncEmit: SyncEmitService) {}

  async listDrivers(client: PoolClient, active?: boolean): Promise<DriverDto[]> {
    const where = active === undefined ? '' : `WHERE is_active = ${active ? 'true' : 'false'}`;
    const res = await client.query(`SELECT * FROM drivers ${where} ORDER BY name ASC`);
    return res.rows.map(mapDriver);
  }

  async createDriver(client: PoolClient, dto: CreateDriverDto, actorUserId: UUID): Promise<DriverDto> {
    return withWrite(client, async () => {
      const res = await client.query(
        `INSERT INTO drivers (employee_id, user_id, name, phone, license_number) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [dto.employeeId ?? null, dto.userId ?? null, dto.name, dto.phone ?? null, dto.licenseNumber ?? null],
      );
      const driver = mapDriver(res.rows[0]);
      await this.syncEmit.emit(client, {
        entity: 'drivers',
        op: 'created',
        entityId: driver.id,
        locationId: null,
        actorUserId,
        data: driver,
      });
      return driver;
    });
  }

  async updateDriver(client: PoolClient, id: UUID, dto: UpdateDriverDto, actorUserId: UUID): Promise<DriverDto> {
    return withWrite(client, async () => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.phone !== undefined) set('phone', dto.phone);
      if (dto.licenseNumber !== undefined) set('license_number', dto.licenseNumber);
      if (dto.employeeId !== undefined) set('employee_id', dto.employeeId);
      if (dto.userId !== undefined) set('user_id', dto.userId);
      if (dto.isActive !== undefined) set('is_active', dto.isActive);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(`UPDATE drivers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (res.rows.length === 0) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Driver ${id} not found` });
      }

      const fresh = await client.query(`SELECT * FROM drivers WHERE id = $1`, [id]);
      if (fresh.rows.length === 0) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Driver ${id} not found` });
      const driver = mapDriver(fresh.rows[0]);
      await this.syncEmit.emit(client, { entity: 'drivers', op: 'updated', entityId: id, locationId: null, actorUserId, data: driver });
      return driver;
    });
  }

  async listVehicles(client: PoolClient, active?: boolean): Promise<VehicleDto[]> {
    const where = active === undefined ? '' : `WHERE is_active = ${active ? 'true' : 'false'}`;
    const res = await client.query(`SELECT * FROM vehicles ${where} ORDER BY plate_number ASC`);
    return res.rows.map(mapVehicle);
  }

  async createVehicle(client: PoolClient, dto: CreateVehicleDto, actorUserId: UUID): Promise<VehicleDto> {
    return withWrite(client, async () => {
      const res = await client.query(
        `INSERT INTO vehicles (plate_number, type, brand, model, has_freezer) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [dto.plateNumber, dto.type ?? 'van', dto.brand ?? null, dto.model ?? null, dto.hasFreezer ?? false],
      );
      const vehicle = mapVehicle(res.rows[0]);
      await this.syncEmit.emit(client, { entity: 'vehicles', op: 'created', entityId: vehicle.id, locationId: null, actorUserId, data: vehicle });
      return vehicle;
    });
  }

  async updateVehicle(client: PoolClient, id: UUID, dto: UpdateVehicleDto, actorUserId: UUID): Promise<VehicleDto> {
    return withWrite(client, async () => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.plateNumber !== undefined) set('plate_number', dto.plateNumber);
      if (dto.type !== undefined) set('type', dto.type);
      if (dto.brand !== undefined) set('brand', dto.brand);
      if (dto.model !== undefined) set('model', dto.model);
      if (dto.hasFreezer !== undefined) set('has_freezer', dto.hasFreezer);
      if (dto.isActive !== undefined) set('is_active', dto.isActive);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (res.rows.length === 0) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Vehicle ${id} not found` });
      }

      const fresh = await client.query(`SELECT * FROM vehicles WHERE id = $1`, [id]);
      if (fresh.rows.length === 0) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Vehicle ${id} not found` });
      const vehicle = mapVehicle(fresh.rows[0]);
      await this.syncEmit.emit(client, { entity: 'vehicles', op: 'updated', entityId: id, locationId: null, actorUserId, data: vehicle });
      return vehicle;
    });
  }
}
