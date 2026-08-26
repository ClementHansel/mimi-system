/**
 * Wire types for `/api/import/:entity/*` — mirrors
 * `apps/backend/src/modules/import/import.service.ts`'s `PreviewResult`/
 * `PreviewRowResult`/`CommitResult` exactly (this file has no runtime import
 * of the backend module — a separate frontend/backend package boundary,
 * same as every other feature's wire types under `components/*`).
 */

export type ImportEntityName = 'item_categories' | 'items' | 'products';

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
