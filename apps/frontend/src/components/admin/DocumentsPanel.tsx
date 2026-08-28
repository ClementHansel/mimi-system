'use client';

import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { DOC_KINDS } from '@/lib/shared-types';
import { DocumentDesigner } from '@/components/documents/DocumentDesigner';

/**
 * Admin → Dokumen: one designer per document kind.
 *
 * The sub-tabs are generated from `DOC_KINDS` in `@mimi/shared` rather than
 * listed here, so adding a fifth kind to the shared model gives it a tab
 * automatically instead of leaving a designer that exists but is unreachable.
 *
 * EACH DESIGNER IS MOUNTED LAZILY, by virtue of `TabsContent` rendering only
 * the active tab. That is load-bearing rather than incidental: `DocumentDesigner`
 * fetches its template and presigns its background on mount, so eagerly
 * mounting four of them would fire eight requests to draw one canvas. It also
 * means switching tabs REMOUNTS the designer and discards unsaved edits —
 * which is why the designer shows its "ada perubahan yang belum disimpan"
 * warning inline next to Save, where it is visible before the tab is clicked
 * away from. A cross-tab confirmation dialog was considered and rejected: it
 * would have to reach into `Tabs`, which has no interception point, for a
 * surface where the edit being lost is a box position rather than typed data.
 */
export function DocumentsPanel() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-lg font-semibold">{t('doc.designer.title')}</h2>
      </div>

      <Tabs defaultValue={DOC_KINDS[0]}>
        <TabsList>
          {DOC_KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {t(`doc.designer.kind.${kind}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {DOC_KINDS.map((kind) => (
          <TabsContent key={kind} value={kind}>
            <DocumentDesigner kind={kind} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
