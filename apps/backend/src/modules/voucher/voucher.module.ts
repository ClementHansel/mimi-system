import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { VoucherController } from './voucher.controller';
import { VoucherService } from './voucher.service';
import { VoucherRedemptionService } from './voucher-redemption.service';
import { VoucherRepository } from './voucher.repository';

/**
 * `voucher` — printed discount coupons (owner request 2026-08-27). Tables in
 * migration 254; permission keys seeded by 255.
 *
 * NOT one of the pre-created Wave 2-4 stubs — a genuinely new module, wired
 * into `app.module.ts` following the `ImportModule` precedent that file's own
 * header records.
 *
 * `SyncEngineModule` is imported for ONE provider: `SyncConflictsRepository`.
 * `VoucherRedemptionService` opens a reconciliation exception when an
 * offline-originated sale carries a coupon the server cannot redeem — the
 * alternative was to drop that money silently, which is the failure the whole
 * offline path is arranged to make visible. See that service's header.
 *
 * `VoucherRedemptionService` IS EXPORTED, and it is the only thing here that
 * is. `PosModule` calls it from inside `PosSaleService.applySaleFact` so that
 * BOTH the online REST path and the offline sync projector redeem through one
 * implementation — a second, parallel redemption path that "happens to agree
 * today" is exactly what `PosSaleService`'s own header warns against for the
 * sale itself, and the argument is stronger here because the thing that must
 * not diverge is money.
 *
 * Nothing exports `VoucherService`: the administrative surface is reachable
 * only through this module's own controller.
 */
@Module({
  imports: [SyncEngineModule],
  controllers: [VoucherController],
  providers: [VoucherService, VoucherRedemptionService, VoucherRepository],
  exports: [VoucherRedemptionService, VoucherRepository],
})
export class VoucherModule {}
