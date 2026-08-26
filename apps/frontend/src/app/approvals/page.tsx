'use client';

import { useI18n } from '@/lib/i18n';
import { ApprovalsInboxPanel } from '@/components/approvals/ApprovalsInboxPanel';

/**
 * The approvals inbox — `GET /api/approvals/pending` (CONTRACTS §4.0). Every
 * approver (Supervisor, Kepala Gudang, Manager, Finance, Owner) previously
 * had no queue of their own; this is the screen a Supervisor should be able
 * to open each morning and clear.
 *
 * Reached three ways: the sidebar entry (`nav.ts`'s `approvals`, gated on
 * ANY-of the eleven per-document-type approve keys), the approval-notification
 * deep link (`/approvals/:documentType/:documentId`, this route's sibling), and
 * directly by URL. This comment previously said it was NOT in `nav.ts` and that
 * the entry was an open follow-up — that entry has since landed, so the note is
 * removed rather than left to mislead the next reader into re-adding it.
 */
export default function ApprovalsInboxPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <h1 className="font-display text-2xl font-semibold text-text-primary">
        {t('approvalsInbox.title')}
      </h1>
      <ApprovalsInboxPanel />
    </div>
  );
}
