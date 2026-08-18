import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { UUID, Money, ISODate, Paginated } from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';

export interface CreateSupplierDto {
  code: string;
  name: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  paymentTermsDays?: number | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankAccountName?: string | null;
  outletVisible?: boolean;
}

export interface UpdateSupplierDto {
  code?: string;
  name?: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  paymentTermsDays?: number | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankAccountName?: string | null;
  outletVisible?: boolean;
}

export interface Supplier {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentTermsDays: number;
  bankName: string | null;
  bankAccount: string | null;
  bankAccountName: string | null;
  outletVisible: boolean;
  isActive: boolean;
}

export interface SupplierDirectoryEntry {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  address: string | null;
}

export interface SupplierItem {
  id: UUID;
  itemId: UUID;
  itemName: string;
  supplierSku: string | null;
  currentPrice: Money;
  leadTimeDays: number;
  isPreferred: boolean;
}

export interface PriceHistoryEntry {
  itemId: UUID;
  itemName: string;
  price: Money;
  effectiveDate: ISODate;
  source: 'manual' | 'po';
  recordedBy: string | null;
}

export interface TransactionEntry {
  poId: UUID;
  poNumber: string;
  orderDate: ISODate;
  status: string;
  total: Money;
  paymentStatus: string | null;
}

/**
 * SupplierService — M06 FR-SUP-01..06
 *
 * Implements supplier master data, supplier_items (which goods from which supplier),
 * append-only supplier_price_history, and role-locked visibility (D-20).
 *
 * RLS-scoped: every method receives a PoolClient from the request (already has
 * SET LOCAL ROLE app_user + session vars from RlsContextGuard). Never uses
 * DATABASE_POOL directly (D-21/D-22 — mimi_app has zero table grants).
 *
 * Outlet roles (SUPERVISOR, LEADER_OUTLET) are restricted via PermissionsGuard
 * on the controller (supplier.read, supplier.price.read, supplier.manage).
 */
@Injectable()
export class SupplierService {
  constructor(private readonly syncEmit: SyncEmitService) {}

  /**
   * List all suppliers (full shape including pricing/termin/bank).
   * Outlet-role-restricted at the controller layer (@RequirePermission('supplier.read')).
   */
  async list(
    client: PoolClient,
    q?: string,
    active?: boolean,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<Supplier>> {
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [];
    let where = 'is_active IS NOT FALSE';

    if (active !== undefined) {
      params.push(active);
      where += ` AND is_active = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (name ILIKE $${params.length} OR code ILIKE $${params.length} OR phone ILIKE $${params.length})`;
      const qParam = params.length - 1;
      where = where.replace(`$${params.length}`, `$${qParam}`);
      where += ` OR phone ILIKE $${qParam}`;
    }

    params.push(pageSize, offset);
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM suppliers WHERE ${where}`,
      params.slice(0, -2),
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const res = await client.query<Record<string, any>>(
      `SELECT * FROM suppliers WHERE ${where}
       ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map(this.mapSupplier),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Directory endpoint — outlet-visible suppliers only (name/contact projection).
   * RLS enforces outlet_visible=true for outlet roles; all roles see same stripped shape.
   */
  async getDirectory(
    client: PoolClient,
    q?: string,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<SupplierDirectoryEntry>> {
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [];
    let where = 'is_active IS NOT FALSE AND outlet_visible = true';

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (name ILIKE $${params.length} OR code ILIKE $${params.length} OR phone ILIKE $${params.length})`;
      const qParam = params.length - 1;
      where = where.replace(`$${params.length}`, `$${qParam}`);
      where += ` OR phone ILIKE $${qParam}`;
    }

    params.push(pageSize, offset);
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM suppliers WHERE ${where}`,
      params.slice(0, -2),
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const res = await client.query<Record<string, any>>(
      `SELECT id, code, name, contact_name, phone, address FROM suppliers WHERE ${where}
       ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map(this.mapSupplierDirectoryEntry),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get a single supplier by ID (full shape).
   */
  async getById(client: PoolClient, id: UUID): Promise<Supplier> {
    const res = await client.query<Record<string, any>>('SELECT * FROM suppliers WHERE id = $1', [
      id,
    ]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Supplier not found');
    }
    return this.mapSupplier(res.rows[0]!);
  }

  /**
   * Create a new supplier.
   */
  async create(client: PoolClient, dto: CreateSupplierDto, userId: UUID): Promise<Supplier> {
    if (!dto.code?.trim()) throw new BadRequestException('code is required');
    if (!dto.name?.trim()) throw new BadRequestException('name is required');

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `INSERT INTO suppliers
         (code, name, contact_name, phone, email, address, payment_terms_days, bank_name, bank_account, bank_account_name, outlet_visible, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
         RETURNING *`,
        [
          dto.code.trim(),
          dto.name.trim(),
          dto.contactName ?? null,
          dto.phone ?? null,
          dto.email ?? null,
          dto.address ?? null,
          dto.paymentTermsDays ?? 0,
          dto.bankName ?? null,
          dto.bankAccount ?? null,
          dto.bankAccountName ?? null,
          dto.outletVisible ?? false,
        ],
      );

      if (res.rows.length === 0) throw new Error('Failed to create supplier');
      const supplier = this.mapSupplier(res.rows[0]!);

      await this.syncEmit.emit(undefined, {
        entity: 'suppliers',
        op: 'created',
        entityId: supplier.id,
        locationId: null,
        actorUserId: userId,
        data: { code: supplier.code, name: supplier.name },
      });
      return supplier;
    });
  }

  /**
   * Update a supplier.
   */
  async update(
    client: PoolClient,
    id: UUID,
    dto: UpdateSupplierDto,
    userId: UUID,
  ): Promise<Supplier> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (dto.code !== undefined) set('code', dto.code.trim());
    if (dto.name !== undefined) set('name', dto.name.trim());
    if (dto.contactName !== undefined) set('contact_name', dto.contactName);
    if (dto.phone !== undefined) set('phone', dto.phone);
    if (dto.email !== undefined) set('email', dto.email);
    if (dto.address !== undefined) set('address', dto.address);
    if (dto.paymentTermsDays !== undefined) set('payment_terms_days', dto.paymentTermsDays ?? 0);
    if (dto.bankName !== undefined) set('bank_name', dto.bankName);
    if (dto.bankAccount !== undefined) set('bank_account', dto.bankAccount);
    if (dto.bankAccountName !== undefined) set('bank_account_name', dto.bankAccountName);
    if (dto.outletVisible !== undefined) set('outlet_visible', dto.outletVisible);

    if (sets.length === 0) return this.getById(client, id);

    sets.push('updated_at = NOW()');
    params.push(id);

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );

      if (res.rows.length === 0) {
        throw new NotFoundException('Supplier not found');
      }

      const supplier = this.mapSupplier(res.rows[0]!);

      await this.syncEmit.emit(undefined, {
        entity: 'suppliers',
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId: userId,
        data: { code: supplier.code, name: supplier.name },
      });
      return supplier;
    });
  }

  /**
   * Soft-delete (deactivate) a supplier.
   */
  async deactivate(
    client: PoolClient,
    id: UUID,
    userId: UUID,
  ): Promise<{ id: UUID; deactivated: true }> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: UUID }>(
        `UPDATE suppliers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
        [id],
      );
      if (res.rows.length === 0) {
        throw new NotFoundException('Supplier not found');
      }

      await this.syncEmit.emit(undefined, {
        entity: 'suppliers',
        op: 'deactivated',
        entityId: id,
        locationId: null,
        actorUserId: userId,
        data: { id },
      });
      return { id, deactivated: true };
    });
  }

  /**
   * Get supplier items (which goods this supplier usually supplies).
   */
  async getItems(client: PoolClient, supplierId: UUID): Promise<SupplierItem[]> {
    const res = await client.query<Record<string, any>>(
      `SELECT si.id, si.supplier_id, si.item_id, i.name as item_name, si.supplier_sku,
              si.current_price, si.lead_time_days, si.is_preferred
       FROM supplier_items si
       JOIN items i ON i.id = si.item_id
       WHERE si.supplier_id = $1
       ORDER BY i.name ASC`,
      [supplierId],
    );
    return res.rows.map(this.mapSupplierItem);
  }

  /**
   * Upsert a supplier item (or update its price, which appends to price_history).
   */
  async upsertItem(
    client: PoolClient,
    supplierId: UUID,
    itemId: UUID,
    dto: {
      supplierSku?: string | null;
      currentPrice: Money;
      leadTimeDays?: number;
      isPreferred?: boolean;
    },
    userId: UUID,
  ): Promise<SupplierItem> {
    return withWrite(client, async () => {
      const res = await client.query(
        `INSERT INTO supplier_items (supplier_id, item_id, supplier_sku, current_price, lead_time_days, is_preferred)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (supplier_id, item_id) DO UPDATE SET
           supplier_sku = COALESCE($3, supplier_sku),
           current_price = $4,
           lead_time_days = COALESCE($5, lead_time_days),
           is_preferred = COALESCE($6, is_preferred),
           updated_at = NOW()
         RETURNING id`,
        [
          supplierId,
          itemId,
          dto.supplierSku ?? null,
          dto.currentPrice,
          dto.leadTimeDays ?? 1,
          dto.isPreferred ?? false,
        ],
      );

      if (res.rows.length === 0) throw new Error('Failed to upsert supplier item');
      const itemRow = res.rows[0]!;

      await client.query(
        `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source, recorded_by)
         VALUES ($1, $2, $3, CURRENT_DATE, 'manual', $4)`,
        [supplierId, itemId, dto.currentPrice, userId],
      );

      await this.syncEmit.emit(undefined, {
        entity: 'supplier_items',
        op: 'updated',
        entityId: itemRow.id,
        locationId: null,
        actorUserId: userId,
        data: { supplierId, itemId, currentPrice: dto.currentPrice },
      });

      return this.getItems(client, supplierId).then((items) =>
        items.find((i) => i.itemId === itemId)!,
      );
    });
  }

  /**
   * Delete a supplier item.
   */
  async deleteItem(
    client: PoolClient,
    supplierId: UUID,
    itemId: UUID,
    userId: UUID,
  ): Promise<{ ok: true }> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: UUID }>(
        `DELETE FROM supplier_items WHERE supplier_id = $1 AND item_id = $2 RETURNING id`,
        [supplierId, itemId],
      );
      if (res.rows.length === 0) {
        throw new NotFoundException('Supplier item not found');
      }
      const itemRow = res.rows[0]!;

      await this.syncEmit.emit(undefined, {
        entity: 'supplier_items',
        op: 'deleted',
        entityId: itemRow.id,
        locationId: null,
        actorUserId: userId,
        data: { supplierId, itemId },
      });
      return { ok: true };
    });
  }

  /**
   * Get price history for a supplier (optionally filtered by itemId).
   */
  async getPriceHistory(
    client: PoolClient,
    supplierId: UUID,
    itemId?: UUID,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<PriceHistoryEntry>> {
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [supplierId];
    let where = 'sph.supplier_id = $1';

    if (itemId) {
      params.push(itemId);
      where += ` AND sph.item_id = $${params.length}`;
    }

    params.push(pageSize, offset);
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_price_history sph WHERE ${where}`,
      params.slice(0, -2),
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const res = await client.query<Record<string, any>>(
      `SELECT sph.item_id, i.name as item_name, sph.price, sph.effective_date, sph.source, u.name as recorded_by
       FROM supplier_price_history sph
       JOIN items i ON i.id = sph.item_id
       LEFT JOIN users u ON u.id = sph.recorded_by
       WHERE ${where}
       ORDER BY sph.effective_date DESC, sph.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map(this.mapPriceHistoryEntry),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get purchase history (POs involving this supplier).
   */
  async getTransactions(
    client: PoolClient,
    supplierId: UUID,
    from?: ISODate,
    to?: ISODate,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<TransactionEntry>> {
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [supplierId];
    let where = 'po.supplier_id = $1';

    if (from) {
      params.push(from);
      where += ` AND po.order_date >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      where += ` AND po.order_date <= $${params.length}::date`;
    }

    params.push(pageSize, offset);
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM purchase_orders po WHERE ${where}`,
      params.slice(0, -2),
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    // NOTE (BE-PURCH-FIX sweep): this query previously joined a
    // `purchase_order_lines` table and a `pv.po_id`/`pv.payment_status`
    // shape that don't exist — the real tables/columns are `po_lines`
    // (migration 041) and `payment_verifications.status`, reached via
    // `purchase_orders.payment_verification_id` (migration 094), not a
    // `po_id` FK on `payment_verifications` (that table is a generic
    // `ref_type`/`ref_id` sink shared by 5+ document types, not PO-specific
    // — see `PoHeaderRow`/`accounting/payment-verifications.service.ts`).
    // As written this endpoint could never have executed successfully
    // (`column pv.po_id does not exist`); fixed alongside this ticket's
    // `orderDate`/DATE-column sweep since it's the same method.
    const res = await client.query<Record<string, any>>(
      `SELECT po.id as po_id, po.po_number, po.order_date, po.status,
              COALESCE(SUM(pol.qty_ordered * pol.unit_price), '0') as total,
              pv.status AS payment_status
       FROM purchase_orders po
       LEFT JOIN po_lines pol ON pol.po_id = po.id
       LEFT JOIN payment_verifications pv ON pv.id = po.payment_verification_id
       WHERE ${where}
       GROUP BY po.id, pv.status
       ORDER BY po.order_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map(this.mapTransactionEntry),
      total,
      page,
      pageSize,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────

  private mapSupplier = (r: Record<string, any>): Supplier => ({
    id: r.id,
    code: r.code,
    name: r.name,
    contactName: r.contact_name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    address: r.address ?? null,
    paymentTermsDays: parseInt(r.payment_terms_days ?? '0', 10),
    bankName: r.bank_name ?? null,
    bankAccount: r.bank_account ?? null,
    bankAccountName: r.bank_account_name ?? null,
    outletVisible: r.outlet_visible ?? false,
    isActive: r.is_active ?? true,
  });

  private mapSupplierDirectoryEntry = (r: Record<string, any>): SupplierDirectoryEntry => ({
    id: r.id,
    code: r.code,
    name: r.name,
    contactName: r.contact_name ?? null,
    phone: r.phone ?? null,
    address: r.address ?? null,
  });

  private mapSupplierItem = (r: Record<string, any>): SupplierItem => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    supplierSku: r.supplier_sku ?? null,
    currentPrice: r.current_price ?? '0.00',
    leadTimeDays: parseInt(r.lead_time_days ?? '1', 10),
    isPreferred: r.is_preferred ?? false,
  });

  private mapPriceHistoryEntry = (r: Record<string, any>): PriceHistoryEntry => ({
    itemId: r.item_id,
    itemName: r.item_name,
    price: r.price ?? '0.00',
    // `supplier_price_history.effective_date` is a `DATE` column — `pg` parses it into a
    // local-timezone `Date`; passing it through raw lets JSON's implicit `.toISOString()`
    // shift the calendar day under WITA (UTC+8). See `common/date-only.util.ts`.
    effectiveDate: formatDateOnly(r.effective_date),
    source: r.source,
    recordedBy: r.recorded_by ?? null,
  });

  private mapTransactionEntry = (r: Record<string, any>): TransactionEntry => ({
    poId: r.po_id,
    poNumber: r.po_number,
    // `purchase_orders.order_date` — same `DATE`-column pitfall as above.
    orderDate: formatDateOnly(r.order_date),
    status: r.status,
    total: r.total ?? '0.00',
    paymentStatus: r.payment_status ?? null,
  });
}
