'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ExportButton } from '@/components/common/ExportButton';
import { ImportPanel } from '@/components/import/ImportPanel';
import type { ImportEntityName } from '@/components/import/types';
import type { CsvColumn } from '@/lib/export/csv';

/**
 * The import/export pair for one master-data list, as toolbar buttons.
 *
 * WHY IT LIVES IN THE TOOLBAR AND NOT IN THE SIDEBAR (owner, 2026-08-25:
 * "bulk import and export should be buttons inside the pages that need it, not
 * a separate sidebar item"). Bulk edit is not a destination, it is a thing you
 * do to the list you are already looking at. As its own nav entry it asked the
 * operator to leave the screen, re-state which entity they meant in a dropdown,
 * and then navigate back to see whether anything changed. Mounted here, the
 * entity is implied by the tab, and a successful import reloads the very table
 * underneath it.
 *
 * EXPORT AND IMPORT USE THE SAME COLUMNS ON PURPOSE. The realistic bulk edit is
 * not "author a CSV from the template" — it is "export what exists, fix it in a
 * spreadsheet, import it back". That only works if an exported file is a valid
 * import file, so each caller's `columns` mirror that entity's import columns
 * in `apps/backend/src/modules/import/import-schema.ts`, header for header, and
 * `masterDataIoColumns` below is where that correspondence is stated once.
 * The importer upserts on the natural key, so a round trip updates rather than
 * duplicating.
 */
export function MasterDataIo<T>({
  entity,
  titleKey,
  rows,
  columns,
  filenameBase,
  onImported,
  canImport = true,
}: {
  entity: ImportEntityName;
  /** i18n key for the modal heading — the entity name in the operator's words. */
  titleKey: string;
  rows: T[];
  columns: CsvColumn<T>[];
  filenameBase: string;
  onImported: () => void;
  /**
   * The server checks `item.manage`/`product.manage` per entity regardless
   * (`ImportController.assertPermission`); this only decides whether to OFFER
   * the button, so a read-only viewer is not handed an action that 403s.
   */
  canImport?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {/* CSV only, no `pdfTitle`: master data is edited in a spreadsheet and
          fed back through the importer — a PDF of it would be a dead end. */}
      <ExportButton rows={rows} columns={columns} filenameBase={filenameBase} />
      {canImport && (
        <>
          <Button
            variant="outline"
            leftIcon={<Upload className="size-4" />}
            onClick={() => setOpen(true)}
          >
            {t('importData.openButton')}
          </Button>
          {open && (
            <Modal
              open
              size="lg"
              onClose={() => setOpen(false)}
              title={t('importData.modalTitle', { entity: t(titleKey) })}
            >
              <ImportPanel
                entity={entity}
                onCommitted={() => {
                  // Reload the table behind the modal, but leave the modal open:
                  // the commit result (how many created vs updated) is the
                  // receipt for what just happened, and closing on success would
                  // throw it away before it could be read.
                  onImported();
                }}
              />
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
