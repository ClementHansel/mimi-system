import {
  Body,
  Controller,
  Get,
  Headers,
  InternalServerErrorException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ConfirmDto, PresignDto } from './storage.dto';
import { AttachmentDto, PresignResult, StorageService } from './storage.service';

/** CONTRACTS.md §4.0 `/api/attachments/*` — kernel/storage. */
@Controller('attachments')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  private requireDbClient(req: RequestWithDbContext) {
    if (!req.dbClient) {
      // Defensive only — every route here requires authentication (none are
      // @Public()), so RlsContextGuard always attaches this on success.
      throw new InternalServerErrorException({
        code: 'ERR_INTERNAL',
        message: 'No database context on request',
      });
    }
    return req.dbClient;
  }

  @Post('presign')
  @RequirePermission('attachment.upload')
  async presign(
    @Req() req: RequestWithDbContext,
    @Body() dto: PresignDto,
    // Optional — an offline capture mints its own attachment id before the
    // binary uploads (B-12: the id must exist BEFORE upload so an
    // already-applied sync_events payload referencing it resolves once the
    // photo lands, never pointing at nothing or at a different id). A
    // browser using the plain online flow sends no header and gets a
    // server-minted id exactly as before — see StorageService.presign()'s
    // doc for the full ordering rationale and validation/conflict rules.
    @Headers('x-attachment-id') attachmentIdHeader?: string,
  ): Promise<PresignResult> {
    return this.storage.presign(
      this.requireDbClient(req),
      req.user as JwtAccessPayload,
      dto,
      attachmentIdHeader,
    );
  }

  @Post(':id/confirm')
  @RequirePermission('attachment.upload')
  async confirm(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: ConfirmDto,
  ): Promise<AttachmentDto> {
    return this.storage.confirm(
      this.requireDbClient(req),
      req.user as JwtAccessPayload,
      id,
      dto.sha256,
    );
  }

  @Get(':id/url')
  async getUrl(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.storage.getUrl(
      this.requireDbClient(req),
      req.user as JwtAccessPayload,
      req.locationScope ?? null,
      id,
    );
  }
}
