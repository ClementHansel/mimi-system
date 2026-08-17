import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Balance, Movement, Paginated, RoleKey } from '@mimi/shared';

import { Audited } from '../../common/decorators/audited.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

import { AreaTransferDto } from './dto/area-transfer.dto';
import { HistoryQueryDto } from './dto/history.query';
import { ListBalancesQueryDto } from './dto/list-balances.query';
import { ListMinStockQueryDto } from './dto/list-min-stock.query';
import { ListMovementsQueryDto } from './dto/list-movements.query';
import { LocationScopeQueryDto } from './dto/location-scope.query';
import { UpsertMinStockDto } from './dto/upsert-min-stock.dto';
import { InventoryService, type CallerContext } from './inventory.service';
import type { AreaTransferResult, HistoryDayRow, InventorySummary, LowStockRow, MinStockRuleRow, SuggestionRow } from './types';

/** `M07 inventory` — CONTRACTS.md §4.7. Every mutation runs on `req.dbClient` (the transaction `RlsContextGuard` already opened) and commits explicitly inside the service; every read leaves the transaction for `RlsCleanupInterceptor`'s cleanup ROLLBACK. */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  private callerOf(req: RequestWithDbContext & Request): CallerContext {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationScope: req.locationScope ?? null };
  }

  @Get('balances')
  @RequirePermission('inventory.balance.read')
  async balances(
    @Req() req: RequestWithDbContext & Request,
    @Query() query: ListBalancesQueryDto,
  ): Promise<Paginated<Balance>> {
    return this.service.getBalances(
      req.dbClient!,
      this.callerOf(req),
      { locationId: query.locationId, storageAreaId: query.storageAreaId, itemId: query.itemId, belowMin: query.belowMin, q: query.q },
      query.page,
      query.pageSize,
    );
  }

  @Get('summary')
  @RequirePermission('inventory.balance.read')
  async summary(@Req() req: RequestWithDbContext & Request, @Query() query: LocationScopeQueryDto): Promise<InventorySummary> {
    return this.service.getSummary(req.dbClient!, this.callerOf(req), query.locationId);
  }

  @Get('movements')
  @RequirePermission('inventory.movement.read')
  async movements(
    @Req() req: RequestWithDbContext & Request,
    @Query() query: ListMovementsQueryDto,
  ): Promise<Paginated<Movement>> {
    return this.service.getMovements(
      req.dbClient!,
      this.callerOf(req),
      {
        locationId: query.locationId,
        itemId: query.itemId,
        storageAreaId: query.storageAreaId,
        movementType: query.movementType,
        from: query.from,
        to: query.to,
      },
      query.page,
      query.pageSize,
    );
  }

  @Get('low-stock')
  @RequirePermission('inventory.balance.read')
  async lowStock(@Req() req: RequestWithDbContext & Request, @Query() query: LocationScopeQueryDto): Promise<LowStockRow[]> {
    return this.service.getLowStock(req.dbClient!, this.callerOf(req), query.locationId);
  }

  @Get('min-stock')
  @RequirePermission('inventory.balance.read')
  async minStock(
    @Req() req: RequestWithDbContext & Request,
    @Query() query: ListMinStockQueryDto,
  ): Promise<Paginated<MinStockRuleRow>> {
    return this.service.getMinStock(req.dbClient!, this.callerOf(req), query.locationId, query.page, query.pageSize);
  }

  @Put('min-stock')
  @RequirePermission('inventory.minstock.manage')
  @Audited({ entityType: 'min_stock_rules', action: 'inventory.minstock.manage' })
  async upsertMinStock(
    @Req() req: RequestWithDbContext & Request,
    @Body() body: UpsertMinStockDto,
  ): Promise<MinStockRuleRow[]> {
    return this.service.upsertMinStock(req.dbClient!, this.callerOf(req), body.locationId, body.rules);
  }

  @Get('suggestions')
  @RequirePermission('inventory.suggestion.read')
  async suggestions(@Req() req: RequestWithDbContext & Request, @Query() query: LocationScopeQueryDto): Promise<SuggestionRow[]> {
    return this.service.getSuggestions(req.dbClient!, this.callerOf(req), query.locationId);
  }

  @Post('area-transfer')
  @RequirePermission('inventory.area_transfer.create')
  @Audited({ entityType: 'stock_movements', action: 'inventory.area_transfer.create' })
  async areaTransfer(
    @Req() req: RequestWithDbContext & Request,
    @Body() body: AreaTransferDto,
  ): Promise<AreaTransferResult> {
    return this.service.postAreaTransfer(req.dbClient!, this.callerOf(req), body);
  }

  @Get('history/:itemId')
  @RequirePermission('inventory.movement.read')
  async history(
    @Req() req: RequestWithDbContext & Request,
    @Param('itemId') itemId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryDayRow[]> {
    return this.service.getHistory(req.dbClient!, this.callerOf(req), query.locationId, itemId, query.days);
  }
}
