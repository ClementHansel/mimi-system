import { Controller, Get, InternalServerErrorException, Query, Req } from '@nestjs/common';
import type { Paginated } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { AuditQueryDto } from './audit-query.dto';
import { AuditRow, AuditService } from './audit.service';

/** `GET /api/audit` (CONTRACTS.md §4.0) — F10 audit trail viewer. */
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  async list(
    @Req() request: RequestWithDbContext,
    @Query() query: AuditQueryDto,
  ): Promise<Paginated<AuditRow>> {
    if (!request.dbClient) {
      // Defensive only — RlsContextGuard always attaches this for a
      // non-public, successfully-authorized request.
      throw new InternalServerErrorException({
        code: 'ERR_INTERNAL',
        message: 'No database context on request',
      });
    }
    return this.auditService.query(request.dbClient, query);
  }
}
