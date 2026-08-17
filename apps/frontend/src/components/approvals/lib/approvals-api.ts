/**
 * Typed REST calls for the approvals inbox + deep-link detail screen
 * (CONTRACTS.md §4.0). The two kernel reads (`getPendingApprovals`,
 * `getApprovalDetail`) back both routes this surface owns; `approveDocument`/
 * `rejectDocument` are the generic per-document-type decision calls
 * (`document-types.ts`'s `basePath`) for the 10 document types whose decision
 * body is a plain `{note?}`/`{reason}` shape.
 *
 * replenishment_request is the one document type with a genuinely different
 * approve body (`{note?; amendments?}, FR-LOG-13`) — rather than re-deriving
 * that wire call, this file reuses `warehouse/lib/warehouse-api`'s
 * `approveReplenishment`/`rejectReplenishment`/`getReplenishment`, the exact
 * functions the Kepala Gudang approval queue already calls, so the amend gate
 * has exactly one implementation in the app.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type { ApprovalDetail, PendingApprovalRow } from './types';

export {
  getReplenishment as getReplenishmentForApproval,
  approveReplenishment,
  rejectReplenishment,
} from '@/components/warehouse/lib/warehouse-api';

export function getPendingApprovals(params: { documentType?: string; page?: number; pageSize?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.documentType) qs.set('documentType', params.documentType);
  qs.set('page', String(params.page ?? 1));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return api.get<Paginated<PendingApprovalRow>>(`/approvals/pending?${qs.toString()}`);
}

export function getApprovalDetail(documentType: string, documentId: string) {
  return api.get<ApprovalDetail>(`/approvals/${documentType}/${documentId}`);
}

export function approveDocument(basePath: string, documentId: string, body: { note?: string }) {
  return api.post(`${basePath}/${documentId}/approve`, body);
}

export function rejectDocument(basePath: string, documentId: string, body: { reason: string }) {
  return api.post(`${basePath}/${documentId}/reject`, body);
}
