import { InternalChatShell } from '@/components/chat/InternalChatShell';

/**
 * Internal (staff-to-staff) chat — person-to-person and group. Deliberately
 * a SEPARATE route from `/chat` (the WhatsApp admin inbox at
 * `apps/frontend/src/app/chat/page.tsx`), not a tab inside it: the two are
 * different audiences and different permission keys reached the same way
 * `/chat/me` already sits apart from `/chat` for the same reason.
 *
 * No nav entry is added here on purpose — out of this ticket's file
 * ownership (see the delivery report for the exact i18n keys and the nav
 * entry to wire up).
 */
export default function InternalChatPage() {
  return <InternalChatShell />;
}
