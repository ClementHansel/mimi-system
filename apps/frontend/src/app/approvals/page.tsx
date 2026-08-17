'use client';

import { useI18n } from '@/lib/i18n';
import { OfflineBanner } from '@/components/ui';
import { ApprovalsInboxPanel } from '@/components/approvals/ApprovalsInboxPanel';

/**
 * The approvals inbox — `GET /api/approvals/pending` (CONTRACTS §4.0). Every
 * approver (Supervisor, Kepala Gudang, Manager, Finance, Owner) previously
 * had no queue of their own; this is the screen a Supervisor should be able
 * to open each morning and clear. Not registered in `lib/nav.ts` (that file
 * is frozen after Gate G1 and out of this ticket's owned paths) — reached
 * today via the approval-notification deep link
 * (`/approvals/:documentType/:documentId`, this route's sibling) and directly
 * by URL; see the ticket report for the nav-entry follow-up.
 */
export default function ApprovalsInboxPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <OfflineBanner />
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('approvalsInbox.title')}</h1>
      <ApprovalsInboxPanel />
    </div>
  );
}
