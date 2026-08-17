import type { PoolClient } from 'pg';
import type {
  Drop,
  DropLine,
  Seal,
  SuratJalan,
  TempLog,
  UUID,
} from '@mimi/shared';

/**
 * Shared read-side SQL + row->DTO mapping for `surat-jalan.service.ts` and
 * `drop.service.ts` — kept in one file so both services build the exact same
 * `SuratJalan`/`Drop` shapes (CONTRACTS.md §4.10 `interface` block,
 * re-exported verbatim from `@mimi/shared`'s `interfaces/index.ts`) rather
 * than two independently-drifting row mappers.
 */

export interface SuratJalanHeaderRow {
  id: string;
  sj_number: string;
  origin_location_id: string;
  shipment_type: 'frozen' | 'dry';
  driver_id: string;
  driver_name: string;
  driver_phone: string | null;
  vehicle_id: string;
  vehicle_plate: string;
  vehicle_has_freezer: boolean;
  status: string;
  planned_date: unknown;
  dispatched_at: Date | null;
  completed_at: Date | null;
  created_by_name: string | null;
}

const HEADER_SELECT = `
  SELECT sj.id, sj.sj_number, sj.origin_location_id, st.key AS shipment_type,
         sj.driver_id, dr.name AS driver_name, dr.phone AS driver_phone,
         sj.vehicle_id, v.plate_number AS vehicle_plate, v.has_freezer AS vehicle_has_freezer,
         sj.status, sj.planned_date, sj.dispatched_at, sj.completed_at,
         cu.name AS created_by_name
    FROM surat_jalan sj
    JOIN shipment_types st ON st.id = sj.shipment_type_id
    JOIN drivers dr ON dr.id = sj.driver_id
    JOIN vehicles v ON v.id = sj.vehicle_id
    LEFT JOIN users cu ON cu.id = sj.created_by
`;

function formatDateOnly(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  return String(value);
}

export async function selectSuratJalanHeader(client: PoolClient, id: UUID): Promise<SuratJalanHeaderRow | null> {
  const res = await client.query<SuratJalanHeaderRow>(`${HEADER_SELECT} WHERE sj.id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function selectSuratJalanHeaderForUpdate(client: PoolClient, id: UUID): Promise<SuratJalanHeaderRow | null> {
  const res = await client.query<SuratJalanHeaderRow>(`${HEADER_SELECT} WHERE sj.id = $1 FOR UPDATE OF sj`, [id]);
  return res.rows[0] ?? null;
}

interface DropRow {
  id: string;
  drop_seq: number;
  location_id: string;
  location_name: string;
  city: string;
  replenishment_request_id: string | null;
  status: string;
  departed_at: Date | null;
  arrived_at: Date | null;
  received_by_name: string | null;
  received_at: Date | null;
  signature_attachment_id: string | null;
  discrepancy_notes: string | null;
  failure_reason: string | null;
}

const DROP_SELECT = `
  SELECT d.id, d.drop_seq, d.location_id, l.name AS location_name, l.city,
         d.replenishment_request_id, d.status, d.departed_at, d.arrived_at,
         ru.name AS received_by_name, d.received_at, d.signature_attachment_id,
         d.discrepancy_notes, d.failure_reason
    FROM sj_drops d
    JOIN locations l ON l.id = d.location_id
    LEFT JOIN users ru ON ru.id = d.received_by
`;

export async function selectDropsForSj(client: PoolClient, sjId: UUID): Promise<DropRow[]> {
  const res = await client.query<DropRow>(`${DROP_SELECT} WHERE d.sj_id = $1 ORDER BY d.drop_seq ASC`, [sjId]);
  return res.rows;
}

export interface DropWithSjRow extends DropRow {
  sj_id: string;
}

export async function selectDropById(client: PoolClient, dropId: UUID): Promise<DropWithSjRow | null> {
  const res = await client.query<DropWithSjRow>(`${DROP_SELECT.replace('SELECT d.id', 'SELECT d.sj_id, d.id')} WHERE d.id = $1`, [dropId]);
  return res.rows[0] ?? null;
}

export async function selectDropByIdForUpdate(client: PoolClient, dropId: UUID): Promise<DropWithSjRow | null> {
  const res = await client.query<DropWithSjRow>(
    `${DROP_SELECT.replace('SELECT d.id', 'SELECT d.sj_id, d.id')} WHERE d.id = $1 FOR UPDATE OF d`,
    [dropId],
  );
  return res.rows[0] ?? null;
}

interface LineRow {
  id: string;
  drop_id: string;
  item_id: string;
  item_name: string;
  unit_id: string;
  unit_code: string;
  storage_type: 'frozen' | 'chilled' | 'dry';
  qty: string;
  qty_received: string | null;
  received_storage_area_id: string | null;
  discrepancy_reason: string | null;
  request_line_id: string | null;
}

const LINE_SELECT = `
  SELECT sl.id, sl.drop_id, sl.item_id, i.name AS item_name, sl.unit_id, u.code AS unit_code, i.storage_type,
         sl.qty, sl.qty_received, sl.received_storage_area_id, sl.discrepancy_reason, sl.request_line_id
    FROM sj_lines sl
    JOIN items i ON i.id = sl.item_id
    JOIN units u ON u.id = sl.unit_id
`;

export async function selectLinesForSj(client: PoolClient, sjId: UUID): Promise<LineRow[]> {
  const res = await client.query<LineRow>(`${LINE_SELECT} WHERE sl.sj_id = $1 ORDER BY i.name ASC`, [sjId]);
  return res.rows;
}

export async function selectLinesForDrop(client: PoolClient, dropId: UUID): Promise<LineRow[]> {
  const res = await client.query<LineRow>(`${LINE_SELECT} WHERE sl.drop_id = $1 ORDER BY i.name ASC`, [dropId]);
  return res.rows;
}

/** Locks every line of a drop for the duration of the caller's transaction — the receiving flow updates them one by one. */
export async function selectLinesForDropForUpdate(client: PoolClient, dropId: UUID): Promise<LineRow[]> {
  const res = await client.query<LineRow>(`${LINE_SELECT} WHERE sl.drop_id = $1 ORDER BY i.name ASC FOR UPDATE OF sl`, [dropId]);
  return res.rows;
}

interface TempLogRow {
  id: string;
  drop_id: string | null;
  stage: 'load' | 'depart' | 'arrive';
  temp_c: string;
  is_breach: boolean;
  logged_by_name: string | null;
  logged_at: Date;
}

export async function selectTempLogsForSj(client: PoolClient, sjId: UUID): Promise<TempLogRow[]> {
  const res = await client.query<TempLogRow>(
    `SELECT t.id, t.drop_id, t.stage, t.temp_c, t.is_breach, u.name AS logged_by_name, t.logged_at
       FROM sj_temperature_logs t
       LEFT JOIN users u ON u.id = t.logged_by
      WHERE t.sj_id = $1
      ORDER BY t.logged_at ASC`,
    [sjId],
  );
  return res.rows;
}

interface SealRow {
  id: string;
  drop_id: string | null;
  seal_number: string;
  status: string;
  checked_by_name: string | null;
  checked_at: Date | null;
}

export async function selectSealsForSj(client: PoolClient, sjId: UUID): Promise<SealRow[]> {
  const res = await client.query<SealRow>(
    `SELECT s.id, s.drop_id, s.seal_number, s.status, u.name AS checked_by_name, s.checked_at
       FROM sj_seals s
       LEFT JOIN users u ON u.id = s.checked_by
      WHERE s.sj_id = $1
      ORDER BY s.created_at ASC`,
    [sjId],
  );
  return res.rows;
}

/** Attachment ids for a drop's receiving photos (`kind='receiving_photo'`) — resolved to presigned URLs by the caller (StorageService), not here (this file has no `user`/`locationScope` context). */
export async function selectDropPhotoAttachmentIds(client: PoolClient, dropId: UUID): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM attachments WHERE entity_type = 'sj_drop' AND entity_id = $1 AND kind = 'receiving_photo' ORDER BY created_at ASC`,
    [dropId],
  );
  return res.rows.map((r) => r.id);
}

export function mapDropLine(r: LineRow): DropLine {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    unitCode: r.unit_code,
    storageType: r.storage_type,
    qty: r.qty,
    qtyReceived: r.qty_received,
    receivedStorageAreaId: r.received_storage_area_id,
    discrepancyReason: r.discrepancy_reason,
  };
}

/** `signatureUrl`/`photoUrls` are resolved by the caller (needs `StorageService` + request `user`/`locationScope`) and merged in — this pure mapper fills them with `null`/`[]` placeholders. */
export function mapDropBase(r: DropRow, lines: LineRow[]): Drop {
  return {
    id: r.id,
    dropSeq: r.drop_seq,
    locationId: r.location_id,
    locationName: r.location_name,
    city: r.city,
    replenishmentRequestId: r.replenishment_request_id,
    status: r.status as Drop['status'],
    departedAt: r.departed_at ? r.departed_at.toISOString() : null,
    arrivedAt: r.arrived_at ? r.arrived_at.toISOString() : null,
    receivedBy: r.received_by_name,
    receivedAt: r.received_at ? r.received_at.toISOString() : null,
    signatureUrl: null,
    photoUrls: [],
    discrepancyNotes: r.discrepancy_notes,
    lines: lines.map(mapDropLine),
  };
}

export function mapTempLog(r: TempLogRow): TempLog {
  return {
    id: r.id,
    dropId: r.drop_id,
    stage: r.stage,
    tempC: r.temp_c,
    isBreach: r.is_breach,
    loggedBy: r.logged_by_name ?? '',
    loggedAt: r.logged_at.toISOString(),
  };
}

export function mapSeal(r: SealRow): Seal {
  return {
    id: r.id,
    dropId: r.drop_id,
    sealNumber: r.seal_number,
    status: r.status as Seal['status'],
    checkedBy: r.checked_by_name,
    checkedAt: r.checked_at ? r.checked_at.toISOString() : null,
  };
}

/** Assembles the full `SuratJalan` DTO — drops WITH their lines, seals, and temperature logs. Used by `GET :id` and `my-jobs`. */
export async function buildSuratJalanFull(client: PoolClient, header: SuratJalanHeaderRow): Promise<SuratJalan> {
  const [dropRows, lineRows, tempRows, sealRows] = await Promise.all([
    selectDropsForSj(client, header.id),
    selectLinesForSj(client, header.id),
    selectTempLogsForSj(client, header.id),
    selectSealsForSj(client, header.id),
  ]);
  const linesByDrop = new Map<string, LineRow[]>();
  for (const l of lineRows) {
    const list = linesByDrop.get(l.drop_id) ?? [];
    list.push(l);
    linesByDrop.set(l.drop_id, list);
  }
  return {
    id: header.id,
    sjNumber: header.sj_number,
    originLocationId: header.origin_location_id,
    shipmentType: header.shipment_type,
    driver: { id: header.driver_id, name: header.driver_name, phone: header.driver_phone },
    vehicle: { id: header.vehicle_id, plateNumber: header.vehicle_plate, hasFreezer: header.vehicle_has_freezer },
    status: header.status as SuratJalan['status'],
    plannedDate: formatDateOnly(header.planned_date),
    dispatchedAt: header.dispatched_at ? header.dispatched_at.toISOString() : null,
    completedAt: header.completed_at ? header.completed_at.toISOString() : null,
    drops: dropRows.map((d) => mapDropBase(d, linesByDrop.get(d.id) ?? [])),
    seals: sealRows.map(mapSeal),
    tempLogs: tempRows.map(mapTempLog),
    createdBy: header.created_by_name ?? '',
  };
}

/** Light `SuratJalan` for list views ("without lines" — CONTRACTS.md §4.10): drops present (route visibility) but each drop's `lines`/the SJ's `seals`/`tempLogs` are empty. */
export async function buildSuratJalanSummary(client: PoolClient, header: SuratJalanHeaderRow): Promise<SuratJalan> {
  const dropRows = await selectDropsForSj(client, header.id);
  return {
    id: header.id,
    sjNumber: header.sj_number,
    originLocationId: header.origin_location_id,
    shipmentType: header.shipment_type,
    driver: { id: header.driver_id, name: header.driver_name, phone: header.driver_phone },
    vehicle: { id: header.vehicle_id, plateNumber: header.vehicle_plate, hasFreezer: header.vehicle_has_freezer },
    status: header.status as SuratJalan['status'],
    plannedDate: formatDateOnly(header.planned_date),
    dispatchedAt: header.dispatched_at ? header.dispatched_at.toISOString() : null,
    completedAt: header.completed_at ? header.completed_at.toISOString() : null,
    drops: dropRows.map((d) => mapDropBase(d, [])),
    seals: [],
    tempLogs: [],
    createdBy: header.created_by_name ?? '',
  };
}
