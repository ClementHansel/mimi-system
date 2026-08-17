import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'audited';

export interface AuditedOptions {
  /** Module name for `audit_log.module`, e.g. `'replenishment'`. Defaults to the controller's module context if omitted. */
  module?: string;
  /** `audit_log.entity_type`, e.g. `'replenishment_request'`. */
  entityType?: string;
  /** `audit_log.action`; defaults to the route's permission key/verb if omitted. */
  action?: string;
}

/**
 * Marks a mutating endpoint for before/after diff auditing (FR-AUDIT-01/02,
 * D-09). This decorator ONLY attaches metadata — it does nothing on its own.
 *
 * The real interceptor is `kernel/audit`'s (W2-C, Wave 2). Until W2-C lands,
 * `kernel/audit/audit.module.ts` is the empty stub W1-D pre-created and
 * already imported into `app.module.ts` (BUILD-PLAN §6 rule 2): W2-C fills
 * that file with a real `AuditModule` that provides `APP_INTERCEPTOR` from
 * INSIDE `kernel/audit/**` — Nest picks up `APP_INTERCEPTOR`/`APP_GUARD`
 * providers globally regardless of which imported module declares them, so
 * auditing switches on the moment W2-C's module has real logic, with zero
 * further edits to `app.module.ts` by anyone. Wave 3/4 modules can annotate
 * `@Audited()` today, safely: it is inert (no interceptor reads this
 * metadata yet) until then, never broken.
 *
 * CONTRACTS.md §0: "Every mutating endpoint: @RequirePermission(<key>) +
 * @Audited() + emits a sync event."
 *
 * @example
 *   @Audited({ entityType: 'replenishment_request', action: 'replenishment.approve.warehouse' })
 *   @Post(':id/approve')
 *   approve(...) { ... }
 */
export const Audited = (options: AuditedOptions = {}) => SetMetadata(AUDITED_KEY, options);
