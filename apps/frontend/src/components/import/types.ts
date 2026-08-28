/**
 * Wire types for `/api/import/:entity/*` — mirrors
 * `apps/backend/src/modules/import/import.service.ts`'s `PreviewResult`/
 * `PreviewRowResult`/`CommitResult` exactly (this file has no runtime import
 * of the backend module — a separate frontend/backend package boundary,
 * same as every other feature's wire types under `components/*`).
 */

/**
 * Must match `IMPORT_ENTITIES` in
 * `apps/backend/src/modules/import/import-schema.ts` — that array is the
 * authority, and `/api/import/:entity/*` 400s on anything not in it. The two
 * lists cannot be checked by the compiler (separate packages), so a name added
 * there has to be added here before any UI can offer it.
 */
export type ImportEntityName =
  | 'item_categories'
  | 'items'
  | 'products'
  | 'chart_of_accounts'
  | 'employees'
  | 'work_shifts'
  | 'assets'
  | 'salary_components'
  | 'suppliers'
  | 'employment_contracts';

export type ImportRowStatus = 'would-create' | 'would-update' | 'error';

export interface ImportRowError {
  column?: string;
  message: string;
}

export interface ImportPreviewRow {
  line: number;
  status: ImportRowStatus;
  naturalKey: string | null;
  errors: ImportRowError[];
}

export interface ImportPreviewResult {
  entity: ImportEntityName;
  fileErrors: ImportRowError[];
  totalDataRows: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
  rows: ImportPreviewRow[];
}

export interface ImportCommitResult {
  entity: ImportEntityName;
  inserted: number;
  updated: number;
}
