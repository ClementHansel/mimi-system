import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { can, RoleKey } from '@mimi/shared';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient } from './request-db-client';
import { ItemService } from './item.service';
import { ItemCategoryService } from './item-category.service';
import { UnitService } from './unit.service';
import { CreateItemCategoryDto, CreateItemDto, ListItemsQueryDto, UpdateItemCategoryDto, UpdateItemDto } from './dto/item.dto';
import { PutConversionsDto } from './dto/conversion.dto';

/** M04 `item` — CONTRACTS.md §4.4 (stockable items, categories, units, unit conversions). */
@Controller('items')
export class ItemController {
  constructor(
    private readonly items: ItemService,
    private readonly categories: ItemCategoryService,
    private readonly units: UnitService,
  ) {}

  private canReadCost(user: JwtAccessPayload): boolean {
    return can(user.roleKey as RoleKey, 'supplier.price.read');
  }

  @Get()
  @RequirePermission('item.read')
  list(@Req() req: Request, @Query() query: ListItemsQueryDto, @CurrentUser() user: JwtAccessPayload) {
    return this.items.list(requireDbClient(req), query, this.canReadCost(user));
  }

  @Get('categories')
  @RequirePermission('item.read')
  listCategories(@Req() req: Request) {
    return this.categories.list(requireDbClient(req));
  }

  @Post('categories')
  @RequirePermission('item.manage')
  @Audited({ entityType: 'item_category', action: 'item.manage' })
  @HttpCode(HttpStatus.CREATED)
  createCategory(@Req() req: Request, @Body() dto: CreateItemCategoryDto, @CurrentUser() user: JwtAccessPayload) {
    return this.categories.create(requireDbClient(req), dto, user.sub);
  }

  @Patch('categories/:id')
  @RequirePermission('item.manage')
  @Audited({ entityType: 'item_category', action: 'item.manage' })
  updateCategory(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateItemCategoryDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.categories.update(requireDbClient(req), id, dto, user.sub);
  }

  @Get(':id')
  @RequirePermission('item.read')
  get(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.items.getById(requireDbClient(req), id, this.canReadCost(user));
  }

  @Post()
  @RequirePermission('item.manage')
  @Audited({ entityType: 'item', action: 'item.manage' })
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: Request, @Body() dto: CreateItemDto, @CurrentUser() user: JwtAccessPayload) {
    return this.items.create(requireDbClient(req), dto, user.sub);
  }

  @Patch(':id')
  @RequirePermission('item.manage')
  @Audited({ entityType: 'item', action: 'item.manage' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateItemDto, @CurrentUser() user: JwtAccessPayload) {
    return this.items.update(requireDbClient(req), id, dto, user.sub);
  }

  @Delete(':id')
  @RequirePermission('item.manage')
  @Audited({ entityType: 'item', action: 'item.manage' })
  deactivate(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.items.deactivate(requireDbClient(req), id, user.sub);
  }

  @Get(':id/conversions')
  @RequirePermission('item.read')
  getConversions(@Req() req: Request, @Param('id') id: string) {
    return this.units.getConversions(requireDbClient(req), id);
  }

  @Put(':id/conversions')
  @RequirePermission('item.manage')
  @Audited({ entityType: 'unit_conversion', action: 'item.manage' })
  putConversions(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PutConversionsDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.units.putConversions(requireDbClient(req), id, dto, user.sub);
  }
}
