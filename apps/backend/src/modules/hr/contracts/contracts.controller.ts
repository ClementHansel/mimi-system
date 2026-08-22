import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  CreateContractDto,
  ListContractsQueryDto,
  TerminateContractDto,
  UpdateContractDto,
} from '../dto/contract.dto';
import { ContractsService } from './contracts.service';

/**
 * M14 `hr` — employment contracts (kontrak kerja), W7.
 *
 * Three permission tiers, and the split matters: `hr.contract.read.own` is
 * universal (your own contract is not privileged to you and it is the whole
 * point of the `employee` interface's Kontrak tab), `hr.contract.read` is the
 * office's read-anyone key, and `hr.contract.manage` — owner/HR only — is the
 * only way to write one. An employee reads their contract; they never author it.
 */
@Controller('hr/contracts')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  /**
   * The caller's OWN contracts. Declared before `:id` so the literal route
   * wins, and gated on the universal key — RLS (migration 230) independently
   * restricts the rows to this employee's.
   */
  @Get('me')
  @RequirePermission('hr.contract.read.own')
  listOwn(@Req() req: RequestWithDbContext) {
    return this.service.listOwn(req.dbClient!, req.user!.sub);
  }

  @Get()
  @RequirePermission('hr.contract.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListContractsQueryDto) {
    return this.service.list(req.dbClient!, query);
  }

  @Get(':id')
  @RequirePermission('hr.contract.read')
  getById(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getById(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateContractDto) {
    return this.service.create(req.dbClient!, req.user!.sub, dto);
  }

  @Patch(':id')
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.service.update(req.dbClient!, id, dto);
  }

  /** Ends a contract early, with a reason on the record (a CHECK enforces it). */
  @Post(':id/terminate')
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  terminate(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: TerminateContractDto,
  ) {
    return this.service.terminate(req.dbClient!, id, dto);
  }

  /**
   * Marks lapsed contracts `expired`. An explicit action rather than a trigger
   * or a cron the user cannot see — it returns what it changed, so HR reads the
   * consequence instead of trusting a count.
   */
  @Post('sweep-expired')
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  sweepExpired(@Req() req: RequestWithDbContext) {
    return this.service.sweepExpired(req.dbClient!);
  }
}
