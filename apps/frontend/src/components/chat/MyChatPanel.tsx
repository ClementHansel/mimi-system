'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Card, EmptyState, toast } from '@/components/ui';
import { MessageThread } from './MessageThread';
import { getMyChat, sendMyMessage, type ChatMessage } from './lib/chat-api';

/**
 * The CLIENT side of chat: one staff member's own thread with head office.
 *
 * There is no conversation picker and no id in any request — the server
 * resolves the thread from the session. That is a security property, not a
 * simplification: accepting an id here would let any authenticated user post
 * into somebody else's conversation.
 *
 * Reachable by every role, including driver and kasir, who hold no location
 * scope and never see the admin inbox.
 */
export function MyChatPanel() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await getMyChat();
      setMessages(res.messages);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSend(body: string) {
    try {
      const sent = await sendMyMessage(body);
      setMessages((prev) => [...prev, sent]);
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    }
  }

  return (
    // Fills the viewport instead of a fixed 560px card floating in a tall page.
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('chat.myTitle')}</h1>
      {/* No WhatsApp-gateway notice here. Mail is an INTERNAL surface — it is
          in every interface, it is read in-app by head office, and since
          2026-08-27 WhatsApp is the dashboard's feature alone. The banner
          ("not delivered to anyone's phone yet") described a delivery path
          this screen no longer claims to have, so on Mail it was noise. It
          stays on `/chat` (`ChatShell`), the WhatsApp inbox, where a supplier
          or customer genuinely only exists at the other end of the gateway.

          Note the backend still attempts a WA send on this thread when the
          staff member has a phone on file (`ChatService.sendMessage`) —
          decoupling that is a backend change, deliberately not made here. */}
      <Card className="flex min-h-0 flex-1 flex-col p-0">
        {loading ? (
          <EmptyState title={t('table.loading')} />
        ) : failed ? (
          <EmptyState title={t('table.error')} />
        ) : (
          <MessageThread messages={messages} onSend={onSend} emptyTitle={t('chat.myEmpty')} />
        )}
      </Card>
    </div>
  );
}
