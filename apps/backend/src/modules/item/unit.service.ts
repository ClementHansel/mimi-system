import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, SyncEntity, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { CreateUnitDto } from './dto/item.dto';
import { PutConversionsDto } from './dto/conversion.dto';

export interface Unit {
  id: UUID;
  code: string;
  name: string;
}

export interface UnitConversion {
  id: UUID;
  fromUnit: string;
  toUnit: string;
  factor: string;
}

/**
 * Units + unit conversions (`units`, `unit_conversions`) — CONTRACTS.md
 * §4.4. Unit conversion MATH itself (`qty_to = qty_from × factor`) lives in
 * `@mimi/shared`'s `convertQty` (packages/shared/src/qty.ts) — this service
 * only persists the factor table; every consumer (recipes, replenishment,
 * stock valuation) is expected to call `convertQty` with the factor read
 * from here, never to re-derive it. No RLS (§1.14 NONE) — API-gated only.
 */
@Injectable()
export class UnitService {
  constructor(private readonly sync: SyncEmitService) {}

  async listUnits(client: PoolClient): Promise<Unit[]> {
    const res = await client.query<Unit>(
      `SELECT id, code, name FROM units WHERE is_active = true ORDER BY code ASC`,
    );
    return res.rows;
  }

  async createUnit(client: PoolClient, dto: CreateUnitDto, actorUserId: string): Promise<Unit> {
    return withWrite(client, async () => {
      const res = await client.query<Unit>(
        `INSERT INTO units (code, name) VALUES ($1,$2) RETURNING id, code, name`,
        [dto.code, dto.name],
      );
      const unit = res.rows[0]!;
      await this.sync.emit(client, {
        entity: SyncEntity.UNITS,
        op: 'created',
        entityId: unit.id,
        locationId: null,
        actorUserId,
        data: unit,
      });
      return unit;
    });
  }

  private async ensureItemExists(client: PoolClient, itemId: string): Promise<void> {
    const res = await client.query(`SELECT 1 FROM items WHERE id = $1`, [itemId]);
    if (res.rowCount === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item not found' });
  }

  async getConversions(client: PoolClient, itemId: string): Promise<UnitConversion[]> {
    await this.ensureItemExists(client, itemId);
    const res = await client.query<{
      id: string;
      from_unit: string;
      to_unit: string;
      factor: string;
    }>(
      `SELECT uc.id, fu.code AS from_unit, tu.code AS to_unit, uc.factor
       FROM unit_conversions uc
       JOIN units fu ON fu.id = uc.from_unit_id
       JOIN units tu ON tu.id = uc.to_unit_id
       WHERE uc.item_id = $1
       ORDER BY fu.code ASC, tu.code ASC`,
      [itemId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      fromUnit: r.from_unit,
      toUnit: r.to_unit,
      factor: r.factor,
    }));
  }

  /** Full replace of the item's conversion set (CONTRACTS.md §4.4 `PUT .../conversions`). */
  async putConversions(
    client: PoolClient,
    itemId: string,
    dto: PutConversionsDto,
    actorUserId: string,
  ): Promise<UnitConversion[]> {
    return withWrite(client, async () => {
      await this.ensureItemExists(client, itemId);
      await client.query(`DELETE FROM unit_conversions WHERE item_id = $1`, [itemId]);
      for (const line of dto.conversions) {
        await client.query(
          `INSERT INTO unit_conversions (item_id, from_unit_id, to_unit_id, factor) VALUES ($1,$2,$3,$4)`,
          [itemId, line.fromUnitId, line.toUnitId, line.factor],
        );
      }
      const conversions = await this.getConversions(client, itemId);
      await this.sync.emit(client, {
        entity: SyncEntity.UNIT_CONVERSIONS,
        op: 'updated',
        entityId: itemId,
        locationId: null,
        actorUserId,
        data: { itemId, conversions },
      });
      return conversions;
    });
  }
}
