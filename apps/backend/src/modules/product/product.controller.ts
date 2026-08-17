import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient, requireLocationScope } from './request-db-client';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';
import { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from './dto/product.dto';
import { PutRecipeDto } from './dto/recipe.dto';

/** M05 `product` — CONTRACTS.md §4.5 (menu products + recipes/BOM, FR-POS-06). */
@Controller('products')
export class ProductController {
  constructor(
    private readonly products: ProductService,
    private readonly recipes: RecipeService,
  ) {}

  @Get()
  @RequirePermission('product.read')
  list(@Req() req: Request, @Query() query: ListProductsQueryDto, @CurrentUser() user: JwtAccessPayload) {
    return this.products.list(requireDbClient(req), query, user, requireLocationScope(req));
  }

  @Get('categories')
  @RequirePermission('product.read')
  categories(@Req() req: Request) {
    return this.products.listCategories(requireDbClient(req));
  }

  @Get(':id')
  @RequirePermission('product.read')
  get(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.products.getById(requireDbClient(req), id, user, requireLocationScope(req));
  }

  @Post()
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product', action: 'product.manage' })
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: Request, @Body() dto: CreateProductDto, @CurrentUser() user: JwtAccessPayload) {
    return this.products.create(requireDbClient(req), dto, user.sub, user, requireLocationScope(req));
  }

  @Patch(':id')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product', action: 'product.manage' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: JwtAccessPayload) {
    return this.products.update(requireDbClient(req), id, dto, user.sub, user, requireLocationScope(req));
  }

  @Delete(':id')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product', action: 'product.manage' })
  deactivate(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.products.deactivate(requireDbClient(req), id, user.sub);
  }

  @Get(':id/recipe')
  @RequirePermission('recipe.read')
  getRecipe(@Req() req: Request, @Param('id') id: string) {
    return this.recipes.getRecipe(requireDbClient(req), id);
  }

  @Put(':id/recipe')
  @RequirePermission('recipe.manage')
  @Audited({ entityType: 'recipe', action: 'recipe.manage' })
  putRecipe(@Req() req: Request, @Param('id') id: string, @Body() dto: PutRecipeDto, @CurrentUser() user: JwtAccessPayload) {
    return this.recipes.putRecipe(requireDbClient(req), id, dto, user.sub);
  }
}
