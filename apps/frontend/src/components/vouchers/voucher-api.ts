'use client';

import { api } from '@/lib/api';
import type { Paginated, UUID } from '@/lib/shared-types';
import type { Voucher, VoucherBatch, VoucherBatchInput } from './types';

/**
 * The voucher API surface, in one place — same discipline as
 * `components/documents/doc-api.ts`: one function per endpoint, typed
 * against the wire shapes in `./types.ts`, so a path typo is a compile
 * error in exactly one file rather than a 404 discovered on the batch
 * screen. Every endpoint is authorization-checked server-side
 * (`voucher.read`/`voucher.manage`/`voucher.issue`); the `can()` gating in
 * the components above this module hides buttons, it is never the boundary.
 */

export function listVoucherBatches(params: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<VoucherBatch>> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const query = qs.toString();
  return api.get<Paginated<VoucherBatch>>(`/vouchers/batches${query ? `?${query}` : ''}`);
}

export function createVoucherBatch(body: VoucherBatchInput): Promise<VoucherBatch> {
  return api.post<VoucherBatch>('/vouchers/batches', body);
}

export function getVoucherBatch(id: UUID): Promise<VoucherBatch> {
  return api.get<VoucherBatch>(`/vouchers/batches/${id}`);
}

export function updateVoucherBatch(
  id: UUID,
  body: Partial<VoucherBatchInput>,
): Promise<VoucherBatch> {
  return api.patch<VoucherBatch>(`/vouchers/batches/${id}`, body);
}

/** Mints `quantity` codes against a batch. Returns how many were actually issued. */
export function issueVoucherBatch(id: UUID, quantity: number): Promise<{ issued: number }> {
  return api.post<{ issued: number }>(`/vouchers/batches/${id}/issue`, { quantity });
}

export function closeVoucherBatch(id: UUID): Promise<VoucherBatch> {
  return api.post<VoucherBatch>(`/vouchers/batches/${id}/close`, undefined);
}

export function listBatchVouchers(
  batchId: UUID,
  params: { page?: number; pageSize?: number },
): Promise<Paginated<Voucher>> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const query = qs.toString();
  return api.get<Paginated<Voucher>>(`/vouchers/batches/${batchId}/vouchers${query ? `?${query}` : ''}`);
}

/** Cancels a single issued code — a misprint, a recalled batch. Terminal (`VoucherStatus.Void`). */
export function voidVoucher(id: UUID): Promise<Voucher> {
  return api.post<Voucher>(`/vouchers/${id}/void`, undefined);
}
