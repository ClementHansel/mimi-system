/**
 * Wire shapes for the approvals inbox + deep-link detail screen
 * (CONTRACTS.md §4.0, kernel `ApprovalService`).
 *
 * `ApprovalDetail`/`ApprovalStepDetail` are imported straight from
 * `@mimi/shared` rather than re-declared here — that package's version
 * carries `currentStep` (the documented "chain finished" signal,
 * `null` once the approval is terminal); other modules'
 * `components/*\/lib/types.ts` forked their own copies before that field
 * existed and lost it as a result. This screen is the canonical consumer of
 * the kernel shape, so it imports the real thing instead of repeating that
 * mistake an eighth time.
 *
 * `PendingApprovalRow` has no `@mimi/shared` equivalent — it is the kernel's
 * internal `PendingApprovalRow` (`apps/backend/src/kernel/approvals/types.ts`),
 * never published to the shared package — so it is transcribed here from
 * CONTRACTS.md §4.0's `GET /api/approvals/pending` row, the same way every
 * other module declares its own module-local resource shapes (Replenishment,
 * PurchaseOrder, …).
 */
export type { ApprovalDetail, ApprovalStepDetail } from '@mimi/shared';
import type { Money, UUID, ISODateTime, ApprovalDocumentType } from '@/lib/shared-types';

export interface PendingApprovalRow {
  approvalId: UUID;
  documentType: ApprovalDocumentType;
  documentId: UUID;
  documentNumber: string | null;
  amount: Money | null;
  locationId: UUID | null;
  locationName: string | null;
  requestedBy: string;
  requestedAt: ISODateTime;
  stepNo: number;
  summary: Record<string, unknown>;
}
