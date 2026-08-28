/**
 * Pins `assetIoColumns`' headers against the BACKEND importer's `assets`
 * column list (`apps/backend/src/modules/import/import-schema.ts`), same
 * reasoning as `components/purchasing/lib/io-columns.test.ts` and
 * `components/hr/lib/io-columns.test.ts`: the frontend cannot import that
 * file (separate package), so the literals below are transcribed from it.
 *
 * `MAINTENANCE_DUE_EXPORT_COLUMNS`/`MAINTENANCE_JOB_EXPORT_COLUMNS` are
 * report-only (see `io-columns.ts`'s header) and covered by decimal/blank
 * assertions instead of a header pin.
 */
import { describe, it, expect } from 'vitest';
import {
  assetIoColumns,
  MAINTENANCE_DUE_EXPORT_COLUMNS,
  MAINTENANCE_JOB_EXPORT_COLUMNS,
} from './io-columns';
import { toCsv } from '@/lib/export/csv';
import type { Asset, DueItem, Job } from './types';

describe('assetIoColumns', () => {
  it("matches the importer's `assets` columns, in order", () => {
    const headers = assetIoColumns(new Map(), new Map()).map((c) => c.header);
    expect(headers).toEqual([
      'asset_number',
      'name',
      'category',
      'location',
      'serial_number',
      'brand',
      'model',
      'purchase_date',
      'purchase_price',
      'assigned_to',
    ]);
  });

  it('omits columns the importer cannot accept', () => {
    // `id`/`condition`/`status`/`photoUrl` are server-owned or set through
    // dedicated screens (condition/status via the detail modal), never a
    // field the importer's `assets` entity accepts.
    const headers = assetIoColumns(new Map(), new Map()).map((c) => c.header);
    expect(headers).not.toContain('id');
    expect(headers).not.toContain('condition');
    expect(headers).not.toContain('status');
  });

  const ASSET: Asset = {
    id: 'a1',
    assetNumber: 'AST-001',
    name: 'Freezer Box 200L',
    category: 'equipment',
    locationName: 'Gudang Pusat',
    serialNumber: 'SN-2024-0012',
    brand: 'Modena',
    model: 'MD-200',
    purchaseDate: '2025-03-01',
    purchasePrice: '15000000.00',
    condition: 'good',
    status: 'active',
    assignedToName: 'Budi Santoso',
    photoUrl: null,
  };

  it('resolves `location`/`assigned_to` via the name lookups, never leaking the display name', () => {
    const csv = toCsv(
      [ASSET],
      assetIoColumns(new Map([['Gudang Pusat', 'GDG']]), new Map([['Budi Santoso', 'EMP001']])),
    );
    expect(csv).toContain('GDG');
    expect(csv).toContain('EMP001');
    expect(csv).not.toContain('Gudang Pusat');
    expect(csv).not.toContain('Budi Santoso');
  });

  it('leaves `location`/`assigned_to` blank rather than guessing when the name is unmapped', () => {
    const csv = toCsv([ASSET], assetIoColumns(new Map(), new Map()));
    const [, row] = csv.split('\r\n');
    const cells = row?.split(',') ?? [];
    expect(cells[3]).toBe(''); // location
    expect(cells[9]).toBe(''); // assigned_to
  });

  it('leaves `assigned_to` blank (not a lookup miss) when no one is assigned', () => {
    const unassigned: Asset = { ...ASSET, assignedToName: null };
    const csv = toCsv(
      [unassigned],
      assetIoColumns(new Map(), new Map([['Budi Santoso', 'EMP001']])),
    );
    expect(csv).not.toContain('EMP001');
  });

  it('keeps `purchase_price` a verbatim decimal string', () => {
    const csv = toCsv([ASSET], assetIoColumns(new Map(), new Map()));
    expect(csv).toContain('15000000.00');
    expect(csv).not.toContain('Rp');
  });

  it('writes blanks, never the literal "null", for absent optionals', () => {
    const bare: Asset = {
      ...ASSET,
      serialNumber: null,
      brand: null,
      model: null,
      purchaseDate: null,
      purchasePrice: undefined,
      assignedToName: null,
    };
    const csv = toCsv([bare], assetIoColumns(new Map(), new Map()));
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('round-trips: the exported header row IS an importable header row', () => {
    const csv = toCsv([ASSET], assetIoColumns(new Map([['Gudang Pusat', 'GDG']]), new Map()));
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe(
      'asset_number,name,category,location,serial_number,brand,model,purchase_date,purchase_price,assigned_to',
    );
  });
});

describe('report-only assets columns', () => {
  const DUE: DueItem = {
    jobId: null,
    scheduleId: 'sch1',
    assetId: 'a1',
    assetName: 'Freezer Box 200L',
    locationName: 'Gudang Pusat',
    name: 'Cek Kompresor',
    dueDate: '2026-09-01',
    overdue: false,
  };

  it('does not mirror importer header names (this is a report, not an import file)', () => {
    const headers = MAINTENANCE_DUE_EXPORT_COLUMNS.map((c) => c.header);
    expect(headers).not.toContain('asset_number');
  });

  it('writes ya/tidak for `overdue`, never a bare boolean', () => {
    const csv = toCsv([DUE], MAINTENANCE_DUE_EXPORT_COLUMNS);
    expect(csv).toContain('tidak');
  });

  const JOB: Job = {
    id: 'j1',
    jobNumber: 'MJ-001',
    assetName: 'Freezer Box 200L',
    type: 'corrective',
    status: 'done',
    dueDate: null,
    assignedToName: null,
    completedAt: '2026-08-20T03:00:00.000Z',
    cost: '250000.00',
    proofUrls: ['url1', 'url2'],
  };

  it('keeps `cost` a verbatim decimal string and blanks stay blank', () => {
    const csv = toCsv([JOB], MAINTENANCE_JOB_EXPORT_COLUMNS);
    expect(csv).toContain('250000.00');
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('Rp');
  });
});
