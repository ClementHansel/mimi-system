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
    <div className="flex flex-col gap-3 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('chat.myTitle')}</h1>
      <p className="rounded-lg bg-warning-50 p-2.5 text-xs text-warning-800">
        {t('chat.deliveryDisabledNotice')}
      </p>
      <Card className="flex h-[560px] flex-col p-0">
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
