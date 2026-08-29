import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupplierService } from './supplier.service';
import { requireDbClient } from './request-db-client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UUID, Paginated } from '@mimi/shared';
import {
  CreateSupplierDto,
  UpdateSupplierDto,
  Supplier,
  SupplierDirectoryEntry,
  SupplierItem,
  PriceHistoryEntry,
  TransactionEntry,
} from './supplier.service';
import { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';

@Controller('suppliers')
@UseGuards(JwtAuthGuard)
export class SupplierController {
  constructor(private readonly service: SupplierService) {}

  /**
   * GET /api/suppliers — full supplier list (pricing/termin/bank visible).
   * FR-SUP-01. Outlet roles (SUPERVISOR, LEADER_OUTLET) get 403 here via @RequirePermission.
   * They use /api/suppliers/directory instead.
   */
  @Get()
  @RequirePermission('supplier.read')
  async list(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('active') active?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<Supplier>> {
    return this.service.list(
      requireDbClient(req),
      q,
      // `active === 'true'` was wrong in a way that emptied the whole page.
      // The param is OPTIONAL, so an absent one arrives as `undefined` — and
      // `undefined === 'true'` is `false`, not `undefined`. The service reads
      // `false` as "asked for inactive only" and appends `AND is_active =
      // false` on top of its own `is_active IS NOT FALSE` baseline, which is a
      // contradiction: zero rows, always. The frontend never sends `active`
      // (see `getSuppliers` in purchasing/lib/api.ts), so the supplier list
      // was unconditionally empty in production with 17 suppliers in the
      // table. Absent must stay absent; only an explicit value filters.
      active === undefined ? undefined : active === 'true',
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  /**
   * GET /api/suppliers/directory — outlet-visible suppliers (name/contact only).
   * FR-SUP-06. All roles including outlet staff can access. RLS filters rows
   * by outlet_visible=true for outlet roles. Returns stripped SupplierDirectoryEntry.
   * Powers petty-cash `storeName` picker (PRD 8.6.1).
   */
  @Get('directory')
  @RequirePermission('supplier.directory.read')
  async getDirectory(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<SupplierDirectoryEntry>> {
    return this.service.getDirectory(
      requireDbClient(req),
      q,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  /**
   * GET /api/suppliers/:id — single supplier (full shape).
   * FR-SUP-01. Outlet roles get 403 via PermissionsGuard.
   */
  @Get(':id')
  @RequirePermission('supplier.read')
  async getById(@Req() req: Request, @Param('id') id: UUID): Promise<Supplier> {
    return this.service.getById(requireDbClient(req), id);
  }

  /**
   * POST /api/suppliers — create a new supplier.
   * FR-SUP-01. Emits sync event.
   */
  @Post()
  @RequirePermission('supplier.manage')
  @Audited({ entityType: 'suppliers', action: 'supplier.manage' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Body() dto: CreateSupplierDto,
  ): Promise<Supplier> {
    return this.service.create(requireDbClient(req), dto, user.sub);
  }

  /**
   * PATCH /api/suppliers/:id — update supplier.
   * FR-SUP-01. Emits sync event.
   */
  @Patch(':id')
  @RequirePermission('supplier.manage')
  @Audited({ entityType: 'suppliers', action: 'supplier.manage' })
  async update(
    @Req() req: Request,
    @Param('id') id: UUID,
    @CurrentUser() user: JwtAccessPayload,
    @Body() dto: UpdateSupplierDto,
  ): Promise<Supplier> {
    return this.service.update(requireDbClient(req), id, dto, user.sub);
  }

  /**
   * DELETE /api/suppliers/:id — soft-delete (deactivate) supplier.
   * FR-SUP-01. Emits sync event.
   */
  @Delete(':id')
  @RequirePermission('supplier.manage')
  @Audited({ entityType: 'suppliers', action: 'supplier.manage' })
  async deactivate(
    @Req() req: Request,
    @Param('id') id: UUID,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<{ id: UUID; deactivated: true }> {
    return this.service.deactivate(requireDbClient(req), id, user.sub);
  }

  /**
   * GET /api/suppliers/:id/items — supplier's items.
   * FR-SUP-03. Pricing data — requires supplier.price.read.
   * Outlet roles get 403.
   */
  @Get(':id/items')
  @RequirePermission('supplier.price.read')
  async getItems(@Req() req: Request, @Param('id') supplierId: UUID): Promise<SupplierItem[]> {
    return this.service.getItems(requireDbClient(req), supplierId);
  }

  /**
   * PUT /api/suppliers/:id/items/:itemId — upsert supplier item.
   * A price change appends to supplier_price_history.
   * FR-SUP-03/04. Emits sync event.
   */
  @Put(':id/items/:itemId')
  @RequirePermission('supplier.price.manage')
  @Audited({ entityType: 'supplier_items', action: 'supplier.price.manage' })
  async upsertItem(
    @Req() req: Request,
    @Param('id') supplierId: UUID,
    @Param('itemId') itemId: UUID,
    @CurrentUser() user: JwtAccessPayload,
    @Body()
    dto: {
      supplierSku?: string | null;
      currentPrice: string;
      leadTimeDays?: number;
      isPreferred?: boolean;
    },
  ): Promise<SupplierItem> {
    return this.service.upsertItem(
      requireDbClient(req),
      supplierId,
      itemId,
      {
        supplierSku: dto.supplierSku,
        currentPrice: dto.currentPrice,
        leadTimeDays: dto.leadTimeDays,
        isPreferred: dto.isPreferred,
      },
      user.sub,
    );
  }

  /**
   * DELETE /api/suppliers/:id/items/:itemId — delete supplier item.
   * FR-SUP-03. Emits sync event.
   */
  @Delete(':id/items/:itemId')
  @RequirePermission('supplier.price.manage')
  @Audited({ entityType: 'supplier_items', action: 'supplier.price.manage' })
  async deleteItem(
    @Req() req: Request,
    @Param('id') supplierId: UUID,
    @Param('itemId') itemId: UUID,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<{ ok: true }> {
    return this.service.deleteItem(requireDbClient(req), supplierId, itemId, user.sub);
  }

  /**
   * GET /api/suppliers/:id/price-history — append-only price history.
   * FR-SUP-04. Pricing data — requires supplier.price.read.
   * Outlet roles get 403.
   */
  @Get(':id/price-history')
  @RequirePermission('supplier.price.read')
  async getPriceHistory(
    @Req() req: Request,
    @Param('id') supplierId: UUID,
    @Query('itemId') itemId?: UUID,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<PriceHistoryEntry>> {
    return this.service.getPriceHistory(
      requireDbClient(req),
      supplierId,
      itemId,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  /**
   * GET /api/suppliers/:id/transactions — purchase order history.
   * FR-SUP-02/05. Requires supplier.read. Outlet roles get 403.
   */
  @Get(':id/transactions')
  @RequirePermission('supplier.read')
  async getTransactions(
    @Req() req: Request,
    @Param('id') supplierId: UUID,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<TransactionEntry>> {
    return this.service.getTransactions(
      requireDbClient(req),
      supplierId,
      from,
      to,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }
}
