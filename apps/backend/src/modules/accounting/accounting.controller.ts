import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Account, Paginated, UUID } from '@mimi/shared';
import { RoleKey, businessDateOf } from '@mimi/shared';
import { Audited, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { JournalService } from './journal.service';
import { PaymentVerificationsService, type PaymentActor } from './payment-verifications.service';
import { ReportsService } from './reports.service';
import { DailyPostingService } from './daily-posting.service';
import { ExceptionsService } from './exceptions.service';
import { GlCoverageService } from './gl-coverage.service';
import {
  BalanceSheetQueryDto,
  ClosePeriodDto,
  CreateAccountDto,
  CreateJournalEntryDto,
  CreatePaymentDto,
  ExceptionVerdictDto,
  ListAccountsQueryDto,
  ListExceptionsQueryDto,
  ListJournalQueryDto,
  ListPaymentsQueryDto,
  PayPaymentDto,
  ProfitLossQueryDto,
  RejectPaymentDto,
  ReopenPeriodDto,
  PostDailyDto,
  ReverseJournalEntryDto,
  StockValueQueryDto,
  TrialBalanceQueryDto,
  UpdateAccountDto,
  UploadProofDto,
  VerifyPaymentDto,
} from './dto/accounting.dto';

/**
 * The most recent business day that is definitely FINISHED, in WITA.
 *
 * Defaulting to today would post a day still being traded, and because the
 * entry is idempotent by (event_type, ref_type, ref_id) the partial figure
 * would then be permanent — a later re-run silently does nothing. Yesterday
 * is the only safe default.
 */
function yesterdayInWita(): string {
  return businessDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

function actorOf(req: RequestWithDbContext): PaymentActor {
  const user = req.user!;
  return {
    userId: user.sub,
    roleKey: user.roleKey as RoleKey,
    locationScope: req.locationScope ?? null,
  };
}

/** CONTRACTS.md §4.17 — chart of accounts + posting rules (read). */
@Controller('accounting/accounts')
export class AccountsController {
  constructor(private readonly coa: ChartOfAccountsService) {}

  @Get()
  @RequirePermission('accounting.coa.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListAccountsQueryDto): Promise<Account[]> {
    return this.coa.list(req.dbClient!, query);
  }

  @Post()
  @RequirePermission('accounting.coa.manage')
  @Audited({ entityType: 'chart_of_accounts', action: 'accounting.coa.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateAccountDto): Promise<Account> {
    return this.coa.create(req.dbClient!, dto);
  }

  @Patch(':id')
  @RequirePermission('accounting.coa.manage')
  @Audited({ entityType: 'chart_of_accounts', action: 'accounting.coa.update' })
  update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ): Promise<Account> {
    return this.coa.update(req.dbClient!, id, dto);
  }
}

@Controller('accounting/posting-rules')
export class PostingRulesController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  @RequirePermission('accounting.coa.read')
  list(@Req() req: RequestWithDbContext, @Query('eventType') eventType?: string) {
    return this.journal.postingRules(req.dbClient!, eventType);
  }
}

/** CONTRACTS.md §4.17 — journal (read + manual post/reverse). */
@Controller('accounting/journal')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  @RequirePermission('accounting.journal.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListJournalQueryDto) {
    return this.journal.list(req.dbClient!, query);
  }

  @Get(':id')
  @RequirePermission('accounting.journal.read')
  detail(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.journal.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('accounting.journal.post')
  @Audited({ entityType: 'journal_entries', action: 'accounting.journal.post' })
  post(@Req() req: RequestWithDbContext, @Body() dto: CreateJournalEntryDto) {
    return this.journal.postManual(req.dbClient!, req.user!.sub, dto);
  }

  @Post(':id/reverse')
  @RequirePermission('accounting.journal.reverse')
  @Audited({ entityType: 'journal_entries', action: 'accounting.journal.reverse' })
  reverse(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: ReverseJournalEntryDto,
  ) {
    return this.journal.reverse(req.dbClient!, req.user!.sub, id, dto.reason);
  }
}

/**
 * CONTRACTS.md §6.2 JOUT-02/JOUT-03 — post a finished business day to the GL.
 *
 * This exists because the backend has NO scheduler: without something calling
 * it, the two daily-aggregate posting rules never fire and POS revenue and
 * COGS never reach the ledger at all (B-16). It is idempotent, so a nightly
 * cron may call it and a human may re-run it for a day that was missed.
 */
@Controller('accounting/daily-posting')
export class DailyPostingController {
  constructor(private readonly daily: DailyPostingService) {}

  @Post()
  @RequirePermission('accounting.journal.post')
  @Audited({ entityType: 'journal_entries', action: 'accounting.journal.post' })
  async post(@Req() req: RequestWithDbContext, @Body() dto: PostDailyDto) {
    const client = req.dbClient!;
    const date = dto.date ?? yesterdayInWita();
    const locations = dto.locationId
      ? [dto.locationId as UUID]
      : await this.daily.locationsWithActivity(client, date);
    const results = [];
    for (const locationId of locations) {
      results.push(await this.daily.postBusinessDay(client, locationId, date));
    }
    return { businessDate: date, locations: results.length, results };
  }
}

/**
 * A-7 — how much history never reached the ledger.
 *
 * READ-ONLY, and the counterpart to `daily-posting` above: that one backfills
 * the SALES side per day; nothing backfills the DOCUMENT side, and before
 * writing something that posts historical money somebody has to be able to see
 * what it would post. This answers that and changes nothing.
 *
 * Gated on `accounting.journal.post` rather than a read key on purpose — the
 * number it returns is only meaningful to whoever could act on it, and it
 * exposes the shape of the ledger's own gaps.
 */
@Controller('accounting/gl-coverage')
export class GlCoverageController {
  constructor(private readonly coverage: GlCoverageService) {}

  @Get()
  @RequirePermission('accounting.journal.post')
  report(@Req() req: RequestWithDbContext) {
    return this.coverage.report(req.dbClient!);
  }
}

/** CONTRACTS.md §4.17 — fiscal periods. */
@Controller('accounting/periods')
export class PeriodsController {
  constructor(private readonly periods: FiscalPeriodsService) {}

  @Get()
  @RequirePermission('accounting.coa.read')
  list(@Req() req: RequestWithDbContext) {
    return this.periods.list(req.dbClient!);
  }

  @Post(':id/close')
  @RequirePermission('accounting.period.close')
  @Audited({ entityType: 'fiscal_periods', action: 'accounting.period.close' })
  close(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ClosePeriodDto) {
    return this.periods.close(req.dbClient!, id, req.user!.sub, dto.note);
  }

  @Post(':id/reopen')
  @RequirePermission('accounting.period.close')
  @Audited({ entityType: 'fiscal_periods', action: 'accounting.period.reopen' })
  reopen(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ReopenPeriodDto) {
    return this.periods.reopen(req.dbClient!, id, dto.reason);
  }
}

/** CONTRACTS.md §4.17 — reports (trial balance, P&L, balance sheet, stock value). */
@Controller('accounting')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('trial-balance')
  @RequirePermission('accounting.report.read')
  trialBalance(@Req() req: RequestWithDbContext, @Query() query: TrialBalanceQueryDto) {
    return this.reports.trialBalance(req.dbClient!, query.periodCode);
  }

  @Get('profit-loss')
  @RequirePermission('accounting.report.read')
  profitLoss(@Req() req: RequestWithDbContext, @Query() query: ProfitLossQueryDto) {
    return this.reports.profitLoss(req.dbClient!, query.from, query.to, query.locationId);
  }

  @Get('balance-sheet')
  @RequirePermission('accounting.report.read')
  balanceSheet(@Req() req: RequestWithDbContext, @Query() query: BalanceSheetQueryDto) {
    return this.reports.balanceSheet(req.dbClient!, query.asOf);
  }

  // NOTE: `asOf` is accepted per CONTRACTS.md §4.17's query shape but not yet honored — `stock_balances`
  // is a current-snapshot table (no as-of-date history without time-slicing `stock_movements`, out of
  // this pass's scope); documented limitation, not a silent gap.
  @Get('stock-value')
  @RequirePermission('accounting.report.read')
  stockValue(@Req() req: RequestWithDbContext, @Query() query: StockValueQueryDto) {
    return this.reports.stockValue(req.dbClient!, query.locationId);
  }
}

/** CONTRACTS.md §4.17, §5.8 — payment verification (FR-ACCT-01..04). */
@Controller('accounting/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentVerificationsService) {}

  @Get()
  @RequirePermission('payment.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListPaymentsQueryDto) {
    return this.payments.list(req.dbClient!, query);
  }

  @Get(':id')
  @RequirePermission('payment.read')
  detail(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.payments.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('payment.proof.upload')
  @Audited({ entityType: 'payment_verifications', action: 'payment.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreatePaymentDto) {
    return this.payments.create(req.dbClient!, actorOf(req), dto);
  }

  @Post(':id/proof')
  @RequirePermission('payment.proof.upload')
  @Audited({ entityType: 'payment_verifications', action: 'payment.proof.upload' })
  uploadProof(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UploadProofDto,
  ) {
    return this.payments.uploadProof(
      req.dbClient!,
      actorOf(req),
      id,
      dto.proofAttachmentId,
      dto.referenceNumber,
    );
  }

  @Post(':id/verify')
  @RequirePermission('payment.verify')
  @Audited({ entityType: 'payment_verifications', action: 'payment.verify' })
  verify(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: VerifyPaymentDto) {
    return this.payments.verify(req.dbClient!, actorOf(req), id, dto.note);
  }

  @Post(':id/pay')
  @RequirePermission('payment.pay')
  @Audited({ entityType: 'payment_verifications', action: 'payment.pay' })
  pay(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: PayPaymentDto) {
    return this.payments.pay(req.dbClient!, actorOf(req), id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('payment.reject')
  @Audited({ entityType: 'payment_verifications', action: 'payment.reject' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectPaymentDto) {
    return this.payments.reject(req.dbClient!, actorOf(req), id, dto.reason);
  }
}

/** CONTRACTS.md §4.17, D-17 — the offline-authorization finance exception queue. */
@Controller('accounting/exceptions')
export class ExceptionsController {
  constructor(private readonly exceptions: ExceptionsService) {}

  @Get()
  @RequirePermission('sync.exception.review')
  list(
    @Req() req: RequestWithDbContext,
    @Query() query: ListExceptionsQueryDto,
  ): Promise<Paginated<unknown>> {
    return this.exceptions.list(req.dbClient!, query);
  }

  @Post(':id/verdict')
  @RequirePermission('sync.exception.review')
  @Audited({ entityType: 'offline_authorizations', action: 'sync.exception.verdict' })
  verdict(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: ExceptionVerdictDto,
  ) {
    return this.exceptions.recordVerdict(req.dbClient!, req.user!.sub, id, dto);
  }
}
