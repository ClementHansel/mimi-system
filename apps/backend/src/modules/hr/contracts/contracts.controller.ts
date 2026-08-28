import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  CreateContractDto,
  ListContractsQueryDto,
  SignContractDto,
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

  /**
   * Every recorded signature for one contract. Gated on EITHER the office's
   * `hr.contract.read` OR the universal `hr.contract.read.own` — unlike
   * `getById` above, this one deliberately also accepts the self-only key:
   * an employee checking whether their own contract still needs a company
   * signature is exactly the "who signed, who is outstanding" view this
   * endpoint exists for (owner ask, W7 follow-up). RLS (migration 252) is
   * still what actually restricts the ROWS returned — a self-only caller who
   * passes someone else's `:id` gets an empty list, not another employee's
   * signatures, the same defence-in-depth the `hr.contract.read.own` path
   * relies on everywhere else in this module.
   */
  @Get(':id/signatures')
  @RequirePermission('hr.contract.read', 'hr.contract.read.own')
  listSignatures(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.listSignatures(req.dbClient!, id);
  }

  /**
   * Records one party's signature (migration 252). `hr.contract.manage` only
   * — there is deliberately NO self-sign path, even for `party: 'employee'`.
   * An employee's own read access (`hr.contract.read.own`) lets them SEE
   * their contract is signed; it does not let them ASSERT that it is. The
   * office (HR/owner) is the one recording that a signature — wet-ink,
   * witnessed, or digital — actually happened, the same control boundary
   * §3 of this ticket draws for the importer (a signature is never something
   * a CSV, or a bare API call from the subject themselves, can manufacture).
   */
  @Post(':id/sign')
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  sign(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: SignContractDto) {
    return this.service.sign(req.dbClient!, id, req.user!.sub, dto);
  }

  /**
   * Hard delete — `draft`, unsigned contracts only (`ContractsService.remove`
   * is where the rule actually lives; see its doc comment). A signed or
   * non-draft contract is a legal record and this never removes one.
   */
  @Delete(':id')
  @RequirePermission('hr.contract.manage')
  @Audited({ module: 'hr', entityType: 'employment_contracts', action: 'hr.contract.manage' })
  async remove(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    await this.service.remove(req.dbClient!, id);
    return { deleted: true };
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
