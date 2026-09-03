'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Plus, RefreshCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Button, Card, EmptyState, Input, Modal, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { MessageThread } from './MessageThread';
import {
  getMessages,
  listConversations,
  markRead,
  openConversation,
  sendMessage,
  setStatus,
  type ChatConversation,
  type ChatMessage,
} from './lib/chat-api';
import { errMsg } from '@/lib/api-error';

/**
 * W7 — the admin chat inbox: every WhatsApp conversation, threaded, with a
 * reply box.
 *
 * Polled rather than pushed. A socket gateway already exists for
 * notifications, but wiring chat into it is only worth doing once messages can
 * actually arrive — `WA_ENABLED=false` means nothing inbound reaches this
 * system yet, so a real-time transport would be untestable plumbing. A 20s
 * poll is honest about that and is a one-line change later.
 */
const POLL_MS = 20_000;

export function ChatShell() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canSend = can('chat.send');
  const canManage = can('chat.manage');

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);

  const reloadList = useCallback(async () => {
    try {
      const res = await listConversations();
      setConversations(res.rows);
      return res.rows;
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
      return [];
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reloadList();
    const handle = setInterval(() => void reloadList(), POLL_MS);
    return () => clearInterval(handle);
  }, [reloadList]);

  const openThread = useCallback(
    async (id: string) => {
      setSelectedId(id);
      try {
        setMessages(await getMessages(id));
        // Marking read is a consequence of OPENING the thread, not of the
        // poll: a badge that cleared itself while nobody looked would hide
        // messages.
        await markRead(id);
        await reloadList();
      } catch {
        toast({ title: t('table.error'), variant: 'danger' });
      }
    },
    [reloadList, t],
  );

  async function onSend(body: string) {
    if (!selectedId) return;
    try {
      const sent = await sendMessage(selectedId, body);
      setMessages((prev) => [...prev, sent]);
      await reloadList();
    } catch {
      toast({ title: t('errors.generic'), variant: 'danger' });
    }
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t('chat.title')}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reloadList()}
            leftIcon={<RefreshCcw className="size-4" />}
          >
            {t('common.refresh')}
          </Button>
          {canSend && (
            <Button
              size="sm"
              leftIcon={<Plus className="size-4" />}
              onClick={() => setNewOpen(true)}
            >
              {t('chat.newConversation')}
            </Button>
          )}
        </div>
      </div>

      {/* Delivery is off until the gateway exists; saying so once here beats a
          user discovering it from a message that never gets a reply. */}
      <p className="rounded-lg bg-warning-50 p-2.5 text-xs text-warning-800">
        {t('chat.deliveryDisabledNotice')}
      </p>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
        <Card className="max-h-[600px] overflow-y-auto p-0">
          {loading && <EmptyState title={t('table.loading')} />}
          {!loading && conversations.length === 0 && <EmptyState title={t('chat.empty')} />}
          <ul>
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void openThread(c.id)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left hover:bg-surface-sunken',
                    selectedId === c.id && 'bg-surface-sunken',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {c.contactName ?? c.contactPhone}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="rounded-full bg-brand-500 px-1.5 text-[11px] font-semibold text-white">
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-text-muted">
                    {c.lastMessagePreview ?? t('chat.noMessages')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex h-[600px] flex-col p-0">
          {!selected ? (
            <EmptyState title={t('chat.selectConversation')} icon={MessageSquare} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border p-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {selected.contactName ?? selected.contactPhone}
                  </p>
                  <p className="text-xs text-text-muted">{selected.contactPhone}</p>
                </div>
                {canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await setStatus(selected.id, selected.status === 'open' ? 'closed' : 'open');
                      await reloadList();
                    }}
                  >
                    {selected.status === 'open' ? t('chat.close') : t('chat.reopen')}
                  </Button>
                )}
              </div>
              <MessageThread
                messages={messages}
                onSend={onSend}
                disabled={!canSend}
                emptyTitle={t('chat.noMessages')}
              />
            </>
          )}
        </Card>
      </div>

      {newOpen && (
        <NewConversationModal
          onClose={() => setNewOpen(false)}
          onCreated={async (id) => {
            setNewOpen(false);
            await reloadList();
            await openThread(id);
          }}
        />
      )}
    </div>
  );
}

function NewConversationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (phone.trim() === '' || saving) return;
    setSaving(true);
    try {
      const convo = await openConversation({
        phone: phone.trim(),
        name: name.trim() || undefined,
      });
      await onCreated(convo.id);
    } catch (err) {
      toast({
        title: errMsg(err, t('errors.generic')),
        variant: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('chat.newConversation')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={phone.trim() === ''}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-text-primary">
            {t('chat.fieldPhone')}
          </span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="08123456789"
            inputMode="tel"
          />
          {/* The server normalises `08…` to `62…`; saying so avoids someone
              "fixing" a number that was already correct. */}
          <span className="mt-1 block text-xs text-text-muted">{t('chat.phoneHint')}</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-text-primary">
            {t('chat.fieldName')}
          </span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
