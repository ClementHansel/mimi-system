import { api } from '@/lib/api';
import type { Paginated } from '@/lib/api';
import { loadAllEmployeesForPicker } from '@/components/hr/lib/hr-api';
import type { SearchableSelectOption } from '@/components/ui/SearchableSelect';

/**
 * Option loaders for "Catat Pembayaran Baru"'s Penerima and Lokasi pickers.
 *
 * ## Why these exist
 *
 * The create modal used to collect `refType`, `payeeType`, `amount`,
 * `referenceNumber` and `notes` — and nothing else. `CreatePaymentDto` has
 * accepted `payeeId`, `refId` and `locationId` the whole time; the form simply
 * never sent them. So the form asked "jenis penerima: supplier" and then never
 * asked WHICH supplier, and `payment_verifications.payee_id`/`location_id`
 * stayed NULL forever on every manually-created voucher.
 *
 * `PV_SELECT` resolves "Penerima" by joining `suppliers`/`employees` on
 * `payee_id` and "Lokasi" by joining `locations` on `location_id`, so both
 * columns rendered as an em-dash on the row and in the drawer, permanently and
 * with no way for the user to fix it. A client asked exactly that — "ini field
 * ini bakal keisinya drmn" (2026-09-09) — and the honest answer was "from
 * nowhere; you cannot fill them".
 *
 * The blank Lokasi cost more than a blank cell: `publishPaymentJournal` gated
 * JOUT-09's journal on `location_id` being present, so a manual voucher posted
 * nothing to the general ledger either. That guard is gone now, but a located
 * voucher still books to the right outlet, which is the point of the picker.
 */

/** `GET /api/locations` — the shape these pickers need, nothing more. */
interface LocationRow {
  id: string;
  name: string;
  code?: string;
}

interface SupplierDirectoryRow {
  id: string;
  code: string;
  name: string;
}

/**
 * Active locations, outlets and warehouses alike.
 *
 * `pageSize=200` rather than a page walk: this is the same call
 * `UsersPanel`/`AssetRegisterPanel`/`EmployeesPanel` already make, and a
 * deployment has tens of locations, not hundreds — unlike `employees`, where
 * production's 295 rows forced the bounded walk in `loadAllEmployeesForPicker`
 * (MA-187). If a tenant ever passes 200 locations this becomes the same bug,
 * so it is worth saying out loud rather than leaving as a silent assumption.
 */
export async function loadLocationOptions(): Promise<SearchableSelectOption[]> {
  const res = await api
    .get<{ rows: LocationRow[] }>('/locations?active=true&pageSize=200')
    .catch(() => null);
  if (!res) return [];
  return res.rows.map((l) => ({ value: l.id, label: l.name, hint: l.code }));
}

/** Supplier directory (`supplier.read`) — code shown as the hint so two similarly-named suppliers are distinguishable. */
export async function loadSupplierOptions(): Promise<SearchableSelectOption[]> {
  const res = await api
    .get<Paginated<SupplierDirectoryRow>>('/suppliers/directory?page=1&pageSize=200')
    .catch(() => null);
  if (!res) return [];
  return res.rows.map((s) => ({ value: s.id, label: s.name, hint: s.code }));
}

/**
 * Every employee, via the shared bounded page walk rather than page 1 of the
 * paginated read — the MA-187 defect, which has now been made twice and is not
 * worth making a third time in this file.
 */
export async function loadEmployeeOptions(): Promise<SearchableSelectOption[]> {
  const all = await loadAllEmployeesForPicker().catch(() => []);
  return all.map((e) => ({ value: e.id, label: e.name, hint: e.employeeNumber }));
}
