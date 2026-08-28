/**
 * Typed REST calls for `/hr/contracts*` (W7 + the 2026-08-27 CRUD/import/
 * export/signature follow-up, migration 230 + 252). Kept in its own file
 * rather than folded into `hr-api.ts` — that file's header already carries
 * F08's original §4.14 surface; this one is scoped to the contracts follow-up
 * alone, mirroring how `components/purchasing/lib/api.ts` stays separate from
 * the rest of purchasing.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type { Contract, ContractSignature } from './types';

export function listContracts(params: {
  employeeId?: string;
  status?: string;
  contractType?: string;
  expiringWithinDays?: number;
  page?: number;
}) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  if (params.status) qs.set('status', params.status);
  if (params.contractType) qs.set('contractType', params.contractType);
  if (params.expiringWithinDays !== undefined)
    qs.set('expiringWithinDays', String(params.expiringWithinDays));
  return api.get<Paginated<Contract>>(`/hr/contracts?${qs.toString()}`);
}

export function getContract(id: string) {
  return api.get<Contract>(`/hr/contracts/${id}`);
}

export function createContract(body: {
  employeeId: string;
  contractType: string;
  position: string;
  locationId?: string;
  baseSalary?: string;
  startDate: string;
  endDate?: string;
  signedAt?: string;
  documentAttachmentId?: string;
  notes?: string;
}) {
  return api.post<Contract>('/hr/contracts', body);
}

export function updateContract(
  id: string,
  body: Partial<{
    contractType: string;
    position: string;
    locationId: string | null;
    baseSalary: string | null;
    startDate: string;
    endDate: string | null;
    status: string;
    signedAt: string | null;
    documentAttachmentId: string | null;
    notes: string | null;
  }>,
) {
  return api.patch<Contract>(`/hr/contracts/${id}`, body);
}

/** Draft-only, unsigned-only — `ContractsService.remove` is where the rule actually lives. */
export function deleteContract(id: string) {
  return api.delete<{ deleted: true }>(`/hr/contracts/${id}`);
}

export function terminateContract(id: string, reason: string, endDate?: string) {
  return api.post<Contract>(`/hr/contracts/${id}/terminate`, { reason, endDate });
}

export function listContractSignatures(id: string) {
  return api.get<ContractSignature[]>(`/hr/contracts/${id}/signatures`);
}

export function signContract(
  id: string,
  body: { party: 'employee' | 'company'; method: string; signedAt?: string; notes?: string },
) {
  return api.post<Contract>(`/hr/contracts/${id}/sign`, body);
}

/**
 * Location `{id, name}` pairs for the contract create/edit form's optional
 * placement field. A separate, small helper rather than reusing
 * `listLocationCodesById` (`hr-api.ts`) — that one is keyed for the
 * IMPORTER's `location` column (id -> CODE); a human filling in a form wants
 * to pick by NAME, so this fetches the same endpoint and keeps both fields.
 */
export function listLocationsForContractForm(): Promise<{ id: string; name: string }[]> {
  return api
    .get<{ rows: { id: string; name: string }[] }>('/locations?active=true&pageSize=200')
    .then((res) => res.rows)
    .catch(() => []);
}
