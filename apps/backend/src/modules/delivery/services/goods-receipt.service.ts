import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_PHOTO_REQUIRED,
  ERR_VALIDATION,
  ERR_VARIANCE_REASON_REQUIRED,
  MovementType,
  businessDateOf,
  compareQty,
  formatCloudDocNumber,
  isNegativeQty,
  type UUID,
} from '@mimi/shared';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import type { PostMovementInput } from '../../../kernel/stock-ledger/stock-ledger.types';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { withWrite } from '../db-tx';
import { assertAreaMatchesStorageType } from '../storage-type.util';
import { CreateGoodsReceiptDto } from '../dto/goods-receipt.dto';

export interface GoodsReceiptDto {
  id: UUID;
  receiptNumber: string;
  receiptType: 'supplier_direct' | 'unmatched_delivery';
  locationId: UUID;
  refId: UUID | null;
  receivedBy: string;
  receivedAt: string;
  status: string;
  notes: string | null;
  lines: {
    itemId: UUID;
    itemName: string;
    storageAreaId: UUID;
    qtyExpected: string;
    qtyReceived: string;
    discrepancyReason: string | null;
  }[];
  photoUrls: string[];
}

/**
 * Supplier-direct-to-outlet receiving (PRD 8.6.1) and blind/unmatched
 * deliveries (SYNC-PROTOCOL §8 row 6: a device that never cached an SJ can
 * still record what arrived, flagged `unmatched_delivery`, reconciled by
 * R5/C6). NOT in CONTRACTS.md §4.10's literal endpoint table — see
 * `dto/goods-receipt.dto.ts`'s header for why this endpoint exists anyway.
 */
@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly stockLedger: StockLedgerService,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async create(client: PoolClient, dto: CreateGoodsReceiptDto, actorUserId: UUID): Promise<GoodsReceiptDto> {
    return withWrite(client, async () => {
      if (dto.photoAttachmentIds.length === 0) {
        throw new BadRequestException({ code: ERR_PHOTO_REQUIRED, message: 'At least one photo is wajib for a goods receipt' });
      }

      const locRes = await client.query<{ id: string }>(`SELECT id FROM locations WHERE id = $1 AND is_active = true`, [dto.locationId]);
      if (!locRes.rows[0]) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Location ${dto.locationId} not found or inactive` });

      const period = businessDateOf(new Date().toISOString()).slice(0, 7).replace('-', '');
      const numRes = await client.query<{ last_number: number }>(
        `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('GR', $1, 1)
         ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
         RETURNING last_number`,
        [period],
      );
      const receiptNumber = formatCloudDocNumber('GR', period, numRes.rows[0]!.last_number);

      const receiptRes = await client.query<{ id: string; received_at: Date }>(
        `INSERT INTO goods_receipts (receipt_number, receipt_type, location_id, ref_id, received_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, received_at`,
        [receiptNumber, dto.receiptType, dto.locationId, dto.refId ?? null, actorUserId, dto.notes ?? null],
      );
      const receiptId = receiptRes.rows[0]!.id;

      const movements: PostMovementInput[] = [];
      const linesOut: GoodsReceiptDto['lines'] = [];
      for (const line of dto.lines) {
        if (isNegativeQty(line.qtyReceived) || isNegativeQty(line.qtyExpected)) {
          throw new BadRequestException({ code: ERR_VALIDATION, message: `Quantities must be >= 0 (item ${line.itemId})` });
        }
        const discrepancy = compareQty(line.qtyReceived, line.qtyExpected) !== 0;
        if (discrepancy && !line.discrepancyReason?.trim()) {
          throw new BadRequestException({ code: ERR_VARIANCE_REASON_REQUIRED, message: `discrepancyReason is required for item ${line.itemId} (dikirim vs diterima differ)` });
        }

        const itemRes = await client.query<{ name: string; storage_type: 'frozen' | 'chilled' | 'dry'; avg_cost: string }>(
          `SELECT name, storage_type, avg_cost FROM items WHERE id = $1`,
          [line.itemId],
        );
        const item = itemRes.rows[0];
        if (!item) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Item ${line.itemId} not found` });

        const areaRes = await client.query<{ type: string; name: string }>(`SELECT type, name FROM storage_areas WHERE id = $1 AND is_active = true`, [line.storageAreaId]);
        const area = areaRes.rows[0];
        if (!area) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Storage area ${line.storageAreaId} not found or inactive` });
        assertAreaMatchesStorageType(item.storage_type, area.type, item.name, area.name);

        await client.query(
          `INSERT INTO goods_receipt_lines (receipt_id, item_id, storage_area_id, qty_expected, qty_received, discrepancy_reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [receiptId, line.itemId, line.storageAreaId, line.qtyExpected, line.qtyReceived, line.discrepancyReason ?? null],
        );

        if (!isNegativeQty(line.qtyReceived) && Number(line.qtyReceived) > 0) {
          movements.push({
            locationId: dto.locationId,
            storageAreaId: line.storageAreaId,
            itemId: line.itemId,
            movementType: MovementType.TRANSFER_IN,
            qty: line.qtyReceived,
            unitCost: item.avg_cost,
            refType: 'goods_receipt',
            refId: receiptId,
            actorId: actorUserId,
          });
        }

        linesOut.push({
          itemId: line.itemId,
          itemName: item.name,
          storageAreaId: line.storageAreaId,
          qtyExpected: line.qtyExpected,
          qtyReceived: line.qtyReceived,
          discrepancyReason: line.discrepancyReason ?? null,
        });
      }

      if (movements.length > 0) {
        await this.stockLedger.post(client, movements, 'strict');
      }

      for (const attachmentId of dto.photoAttachmentIds) {
        await client.query(`UPDATE attachments SET entity_type = 'goods_receipt', entity_id = $2 WHERE id = $1 AND entity_id IS NULL`, [attachmentId, receiptId]);
      }

      await this.syncEmit.emit(client, {
        entity: 'goods_receipts',
        op: 'recorded',
        entityId: receiptId,
        locationId: dto.locationId,
        actorUserId,
        data: {
          id: receiptId,
          locationId: dto.locationId,
          lines: dto.lines.map((l) => ({ itemId: l.itemId, qty: l.qtyReceived, storageAreaId: l.storageAreaId, unitCost: '0.00' })),
          photoAttachmentIds: dto.photoAttachmentIds,
          notes: dto.notes,
        },
      });

      return {
        id: receiptId,
        receiptNumber,
        receiptType: dto.receiptType,
        locationId: dto.locationId,
        refId: dto.refId ?? null,
        receivedBy: actorUserId,
        receivedAt: receiptRes.rows[0]!.received_at.toISOString(),
        status: 'confirmed',
        notes: dto.notes ?? null,
        lines: linesOut,
        photoUrls: dto.photoAttachmentIds,
      };
    });
  }
}
