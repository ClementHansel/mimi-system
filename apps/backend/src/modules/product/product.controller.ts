import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient, requireLocationScope } from './request-db-client';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';
import { ProductCategoryService } from './product-category.service';
import { PackageService } from './package.service';
import { StorageService } from '../../kernel/storage/storage.service';
import { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from './dto/product.dto';
import { PutRecipeDto } from './dto/recipe.dto';
import { PutPackageDto } from './dto/package.dto';
import {
  CreateProductCategoryDto,
  ListProductCategoriesQueryDto,
  ReorderProductCategoriesDto,
  UpdateProductCategoryDto,
} from './dto/product-category.dto';

/**
 * The tile size the POS grid renders at, doubled for a retina panel. Kept as
 * ONE value so every cached thumbnail on every device shares a key — a second
 * size would silently double the bytes each tablet stores.
 */
const PRODUCT_THUMBNAIL_PX = 320;

/** M05 `product` — CONTRACTS.md §4.5 (menu products + recipes/BOM, FR-POS-06). */
@Controller('products')
export class ProductController {
  constructor(
    private readonly products: ProductService,
    private readonly recipes: RecipeService,
    private readonly categories: ProductCategoryService,
    private readonly packages: PackageService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @RequirePermission('product.read')
  list(
    @Req() req: Request,
    @Query() query: ListProductsQueryDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.products.list(requireDbClient(req), query, user, requireLocationScope(req));
  }

  /**
   * EVERY `categories` ROUTE IS DECLARED BEFORE `:id`. Nest matches in
   * declaration order, so moving one below `@Get(':id')` would make
   * `/products/categories` resolve as a product whose id is the literal string
   * "categories" — a 404 that looks like missing data rather than a routing bug.
   */
  @Get('categories')
  @RequirePermission('product.read')
  listCategories(@Req() req: Request, @Query() query: ListProductCategoriesQueryDto) {
    return this.categories.list(requireDbClient(req), query.includeInactive ?? false);
  }

  @Post('categories')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_category', action: 'product.manage' })
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @Req() req: Request,
    @Body() dto: CreateProductCategoryDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.categories.create(requireDbClient(req), dto, user.sub);
  }

  /** Declared before `PATCH categories/:id` so "order" is never read as an id. */
  @Put('categories/order')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_category', action: 'product.manage' })
  reorderCategories(
    @Req() req: Request,
    @Body() dto: ReorderProductCategoriesDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.categories.reorder(requireDbClient(req), dto.ids, user.sub);
  }

  @Patch('categories/:id')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_category', action: 'product.manage' })
  updateCategory(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateProductCategoryDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.categories.update(requireDbClient(req), id, dto, user.sub);
  }

  @Delete('categories/:id')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_category', action: 'product.manage' })
  deactivateCategory(
    @Req() req: Request,
    @Param('id') id: string,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.categories.deactivate(requireDbClient(req), id, user.sub);
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
  create(
    @Req() req: Request,
    @Body() dto: CreateProductDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.products.create(
      requireDbClient(req),
      dto,
      user.sub,
      user,
      requireLocationScope(req),
    );
  }

  @Patch(':id')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product', action: 'product.manage' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.products.update(
      requireDbClient(req),
      id,
      dto,
      user.sub,
      user,
      requireLocationScope(req),
    );
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
  putRecipe(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PutRecipeDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.recipes.putRecipe(requireDbClient(req), id, dto, user.sub);
  }

  /**
   * Package membership (migration 248).
   *
   * Gated by `product.manage`, NOT `recipe.manage`: a package lists MENU items
   * at menu prices, so it reveals nothing about cost structure — which is the
   * whole reason recipes carry their own tighter permission (FR-SUP-06). The
   * roles that set the menu are the roles that compose bundles.
   */
  @Get(':id/package')
  @RequirePermission('product.read')
  getPackage(@Req() req: Request, @Param('id') id: string) {
    return this.packages.getLines(requireDbClient(req), id);
  }

  @Put(':id/package')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_package', action: 'product.manage' })
  putPackage(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PutPackageDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.packages.putLines(requireDbClient(req), id, dto, user.sub);
  }

  /** Turns a package back into a plain product, clearing its membership in the same transaction. */
  @Delete(':id/package')
  @RequirePermission('product.manage')
  @Audited({ entityType: 'product_package', action: 'product.manage' })
  deletePackage(
    @Req() req: Request,
    @Param('id') id: string,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.packages.clearLines(requireDbClient(req), id, user.sub);
  }

  /**
   * The product photo as a small WebP thumbnail — the STABLE address
   * `Product.photoPath` points at, and the one the till precaches.
   *
   * WHY THIS EXISTS ALONGSIDE `photoUrl`: `photoUrl` is a presigned MinIO url
   * that expires in 10 minutes, which is fine for a back-office form and wrong
   * for a POS catalog that is cached and served offline for hours or days
   * (`PosCatalogService`'s header carried this as a known gap). Serving bytes
   * through the api instead gives an address that never expires, so a tablet
   * fetches each photo once into IndexedDB and renders it with no network at
   * all.
   *
   * `product.read` (not `pos.catalog.read`) because this is a product field and
   * every role that may see the menu holds it — including `kasir`.
   *
   * `Cache-Control: private` — the bytes are behind a bearer token; a shared
   * proxy must not keep them. `immutable` is honest here: replacing a product's
   * photo creates a NEW attachment id and therefore a new set of bytes at a key
   * that is derived from it, so what this url returns for a given product never
   * silently changes content without `ETag` changing too.
   */
  @Get(':id/photo')
  @RequirePermission('product.read')
  async getPhoto(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const client = requireDbClient(req);
    const attachmentId = await this.products.getPhotoAttachmentId(client, id);
    if (!attachmentId) {
      res.status(HttpStatus.NOT_FOUND).json({
        code: 'ERR_NOT_FOUND',
        message: 'Product has no photo',
      });
      return;
    }

    const thumb = await this.storage.getThumbnailBytes(
      client,
      user,
      requireLocationScope(req),
      attachmentId,
      PRODUCT_THUMBNAIL_PX,
    );

    // A still-warm device revalidates instead of re-downloading every tile on
    // every catalog refresh — the difference between a few hundred bytes and a
    // few megabytes over an outlet's connection.
    if (req.headers['if-none-match'] === `"${thumb.etag}"`) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }

    res.setHeader('Content-Type', thumb.mimeType);
    res.setHeader('Content-Length', String(thumb.buffer.length));
    res.setHeader('ETag', `"${thumb.etag}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.send(thumb.buffer);
  }
}
