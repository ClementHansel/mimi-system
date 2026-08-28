/** `document_templates` CRUD — see `doc-template.service.ts`'s header. */
import { Body, Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ERR_VALIDATION, isDocKind, type DocTemplate } from '@mimi/shared';
import { DocTemplateService } from './doc-template.service';
import { PutDocTemplateDto } from './doc-template.dto';

@Controller('doc-templates')
export class DocTemplateController {
  constructor(private readonly service: DocTemplateService) {}

  /**
   * `isDocKind` is checked in EVERY route, before anything else — see the
   * ticket-level house rule: an unknown `:kind` must be `ERR_VALIDATION`,
   * not the `ERR_NOT_FOUND` a bare route-param lookup would suggest, because
   * a `kind` isn't a row identity here — it's a fixed, closed enum
   * (`DocKind`), and a value outside it is a malformed request, not a
   * missing resource.
   */
  private assertKind(kind: string): void {
    if (!isDocKind(kind)) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `'${kind}' is not a document kind`,
      });
    }
  }

  @Get(':kind')
  @RequirePermission('doc_template.read')
  getOne(@Param('kind') kind: string, @Req() req: RequestWithDbContext): Promise<DocTemplate> {
    this.assertKind(kind);
    return this.service.getTemplate(kind, req.dbClient!);
  }

  @Put(':kind')
  @RequirePermission('doc_template.manage')
  @Audited({ entityType: 'document_template', action: 'doc_template.manage' })
  putOne(
    @Param('kind') kind: string,
    @Body() dto: PutDocTemplateDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<DocTemplate> {
    this.assertKind(kind);
    return this.service.putTemplate(kind, dto, caller, req.dbClient!);
  }

  @Delete(':kind')
  @RequirePermission('doc_template.manage')
  @Audited({ entityType: 'document_template', action: 'doc_template.manage' })
  resetOne(@Param('kind') kind: string, @Req() req: RequestWithDbContext): Promise<DocTemplate> {
    this.assertKind(kind);
    return this.service.resetTemplate(kind, req.dbClient!);
  }
}
