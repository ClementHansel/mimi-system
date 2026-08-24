import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { can, RoleKey, type PermissionKey } from '@mimi/shared';
import { Audited, CurrentUser } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient, requireLocationScope } from './request-db-client';
import { ImportService } from './import.service';
import { IMPORT_ENTITIES, type ImportEntityName } from './import-schema';

/** 5 MB — generous for a few thousand master-data rows, small enough that a wrong file (a photo, a zip) fails fast rather than tying up an RLS connection. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function assertKnownEntity(entity: string): ImportEntityName {
  if (!IMPORT_ENTITIES.some((e) => e.name === entity)) {
    throw new BadRequestException({
      code: 'ERR_VALIDATION',
      message: `Entitas import tidak dikenal: "${entity}" — yang tersedia: ${IMPORT_ENTITIES.map((e) => e.name).join(', ')}`,
    });
  }
  return entity as ImportEntityName;
}

/**
 * `import` — bulk import with a schema-derived template (owner, 2026-08-24:
 * "add bulk import with template download, so all the import would follow
 * DB so no errors"). Three entities for now — `item_categories`, `items`,
 * `products` — see `import.module.ts`'s header comment for why these and not
 * the originally-suggested `suppliers` (no sync-event authority — see that
 * module's Nest wiring note) or anything transactional.
 *
 * NOT gated by `@RequirePermission()`: the required permission key varies BY
 * `:entity` (`item.manage` vs `product.manage`), and that decorator's keys
 * are fixed at declaration time — it cannot branch on a route param. Every
 * handler below checks `can(user.roleKey, requiredPermission)` itself
 * instead, the same pattern `ItemController.canReadCost` already uses for a
 * permission that depends on runtime data rather than the route alone.
 */
@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  private assertPermission(entity: ImportEntityName, user: JwtAccessPayload): void {
    const required = this.importService.permissionFor(entity) as PermissionKey;
    if (!can(user.roleKey as RoleKey, required)) {
      throw new ForbiddenException({
        code: 'ERR_FORBIDDEN',
        message: `Role '${user.roleKey}' lacks permission: ${required}`,
        details: { required, roleKey: user.roleKey },
      });
    }
  }

  /**
   * GET /api/import/:entity/template — a CSV whose header row and guidance
   * row are generated from the entity's schema definition, never a
   * hardcoded string (`import-schema.ts`'s `IMPORT_ENTITIES`) — a column
   * added there appears in the download without touching this controller.
   */
  @Get(':entity/template')
  getTemplate(
    @Res() res: Response,
    @Param('entity') entityParam: string,
    @CurrentUser() user: JwtAccessPayload,
  ): void {
    const entity = assertKnownEntity(entityParam);
    this.assertPermission(entity, user);
    const csv = this.importService.template(entity);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}_template.csv"`);
    // BOM so Excel (the realistic tool this template round-trips through, per
    // `import-schema.ts`'s `parseCsv` already stripping one on the way back
    // in) opens Indonesian guidance text as UTF-8 instead of guessing Latin-1.
    res.send('﻿' + csv);
  }

  /**
   * POST /api/import/:entity/preview — validates the uploaded file and
   * reports every row's outcome. Writes NOTHING, ever — this is the endpoint
   * that makes the import trustworthy before anyone commits to it.
   */
  @Post(':entity/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async preview(
    @Req() req: Request,
    @Param('entity') entityParam: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    const entity = assertKnownEntity(entityParam);
    this.assertPermission(entity, user);
    if (!file) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'Berkas CSV tidak ditemukan (field "file")',
      });
    }
    return this.importService.preview(requireDbClient(req), entity, file.buffer.toString('utf8'));
  }

  /**
   * POST /api/import/:entity/commit — applies the same file in ONE
   * transaction, all-or-nothing (CONTRACTS §0 mutating-endpoint rule: every
   * write here still goes through `ItemService`/`ItemCategoryService`/
   * `ProductService`, each of which emits its own sync event per row — see
   * `import.service.ts`'s header comment for why that delegation, not a
   * parallel insert path, is the point of this module).
   */
  @Post(':entity/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @Audited({ entityType: 'import', action: 'import.commit' })
  async commit(
    @Req() req: Request,
    @Param('entity') entityParam: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    const entity = assertKnownEntity(entityParam);
    this.assertPermission(entity, user);
    if (!file) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'Berkas CSV tidak ditemukan (field "file")',
      });
    }
    return this.importService.commit(
      requireDbClient(req),
      entity,
      file.buffer.toString('utf8'),
      user.sub,
      user,
      requireLocationScope(req),
    );
  }
}
