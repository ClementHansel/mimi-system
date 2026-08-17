import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';

/**
 * kernel/audit — the real `@Audited()` before/after-diff interceptor
 * (FR-AUDIT-01/02, D-09) and `GET /api/audit` (CONTRACTS.md §4.0).
 *
 * ACTIVATION: providing `{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }`
 * from THIS module's own providers array is what switches auditing on
 * globally — `AuditModule` is already imported into `app.module.ts` (W1-D,
 * Wave 1), so Nest picks up this global-token provider the moment it has
 * real content, with zero further edits to `app.module.ts` ever
 * (BUILD-PLAN §6 rule 2). See `audited.decorator.ts` and
 * `audit.interceptor.ts` for the full mechanism and its design rationale.
 */
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
