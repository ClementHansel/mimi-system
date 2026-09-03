'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Plus, RefreshCcw, Settings, Users, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { Button, Card, EmptyState, Input, Modal, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { MessageThread } from './MessageThread';
import {
  addGroupMember,
  createGroup,
  getConversationDetail,
  getInternalMessages,
  leaveGroup,
  listMyConversations,
  markInternalRead,
  openDirect,
  removeGroupMember,
  renameGroup,
  searchDirectory,
  sendInternalMessage,
  type ChatParticipant,
  type DirectoryUser,
  type InternalConversation,
} from './lib/internal-chat-api';
import type { ChatMessage } from './lib/chat-api';
import { errMsg } from '@/lib/api-error';

/**
 * Internal (staff-to-staff) chat — person-to-person and group. SEPARATE
 * screen from `ChatShell` (the WhatsApp admin inbox): different audience
 * (every role, via `chat.read.own`, not the central-ish `chat.read`/
 * `chat.manage` tier), different data (`/chat/internal/*`, never
 * `/chat/conversations`), and a genuinely different authorization model
 * (your OWN participation, not location/role).
 *
 * Polled, same reasoning `ChatShell` already documents: a real-time
 * transport is a one-line swap later, not a reason to hold up shipping the
 * feature staff are actually waiting on.
 */
const POLL_MS = 15_000;

export function InternalChatShell() {
  const { t } = useI18n();
  const currentUserId = useSessionStore((s) => s.user?.id);

  const [conversations, setConversations] = useState<InternalConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const reloadList = useCallback(async () => {
    try {
      const rows = await listMyConversations();
      setConversations(rows);
      return rows;
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
        setMessages(await getInternalMessages(id));
        // Marking read is a consequence of OPENING the thread, not of the
        // poll — same reasoning as the WhatsApp inbox.
        await markInternalRead(id);
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
      const sent = await sendInternalMessage(selectedId, body);
      setMessages((prev) => [...prev, sent]);
      await reloadList();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    }
  }

  async function onLeave() {
    if (!selectedId) return;
    try {
      await leaveGroup(selectedId);
      setManageOpen(false);
      setSelectedId(null);
      setMessages([]);
      await reloadList();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    }
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          {t('chatInternal.title')}
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reloadList()}
            leftIcon={<RefreshCcw className="size-4" />}
          >
            {t('common.refresh')}
          </Button>
          <Button
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() => setNewChatOpen(true)}
          >
            {t('chatInternal.newChat')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
        <Card className="max-h-[600px] overflow-y-auto p-0">
          {loading && <EmptyState title={t('table.loading')} />}
          {!loading && conversations.length === 0 && <EmptyState title={t('chatInternal.empty')} />}
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
                      {c.name ?? t('chatInternal.unnamed')}
                      {c.kind === 'group' && (
                        <span className="ml-1 text-xs text-text-muted">({c.participantCount})</span>
                      )}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="rounded-full bg-brand-500 px-1.5 text-[11px] font-semibold text-white">
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-text-muted">
                    {c.lastMessagePreview ?? t('chatInternal.noMessages')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex h-[600px] flex-col p-0">
          {!selected ? (
            <EmptyState title={t('chatInternal.selectConversation')} icon={MessageSquare} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border p-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {selected.name ?? t('chatInternal.unnamed')}
                  </p>
                  {selected.kind === 'group' && (
                    <p className="text-xs text-text-muted">
                      {t('chatInternal.memberCount', { count: selected.participantCount })}
                    </p>
                  )}
                </div>
                {selected.kind === 'group' && (
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Settings className="size-4" />}
                    onClick={() => setManageOpen(true)}
                  >
                    {t('chatInternal.manage')}
                  </Button>
                )}
              </div>
              <MessageThread
                messages={messages}
                onSend={onSend}
                emptyTitle={t('chatInternal.noMessages')}
                currentUserId={currentUserId}
              />
            </>
          )}
        </Card>
      </div>

      {newChatOpen && (
        <NewChatModal
          onClose={() => setNewChatOpen(false)}
          onCreated={async (id) => {
            setNewChatOpen(false);
            await reloadList();
            await openThread(id);
          }}
        />
      )}

      {manageOpen && selected && selected.kind === 'group' && (
        <ManageGroupModal
          conversation={selected}
          onClose={() => setManageOpen(false)}
          onLeave={onLeave}
          onChanged={async () => {
            await reloadList();
          }}
        />
      )}
    </div>
  );
}

/**
 * Two modes in one dialog: a direct message (pick ONE colleague, opened
 * immediately) or a new group (a name plus however many colleagues). Both
 * modes share the same directory search — `searchDirectory` (backed by
 * migration 243's `app_chat_directory`, see that file's header on why this
 * cannot be a plain `users` list).
 */
function NewChatModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<DirectoryUser[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      searchDirectory(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  function toggleMember(u: DirectoryUser) {
    setSelectedMembers((prev) =>
      prev.some((m) => m.id === u.id) ? prev.filter((m) => m.id !== u.id) : [...prev, u],
    );
  }

  async function pickDirect(u: DirectoryUser) {
    if (saving) return;
    setSaving(true);
    try {
      const convo = await openDirect(u.id);
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

  async function submitGroup() {
    if (groupName.trim() === '' || selectedMembers.length === 0 || saving) return;
    setSaving(true);
    try {
      const convo = await createGroup(
        groupName.trim(),
        selectedMembers.map((m) => m.id),
      );
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
      title={t('chatInternal.newChat')}
      footer={
        mode === 'group' ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void submitGroup()}
              loading={saving}
              disabled={groupName.trim() === '' || selectedMembers.length === 0}
            >
              {t('chatInternal.createGroup')}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === 'direct' ? 'primary' : 'outline'}
            onClick={() => setMode('direct')}
          >
            {t('chatInternal.modeDirect')}
          </Button>
          <Button
            size="sm"
            variant={mode === 'group' ? 'primary' : 'outline'}
            leftIcon={<Users className="size-4" />}
            onClick={() => setMode('group')}
          >
            {t('chatInternal.modeGroup')}
          </Button>
        </div>

        {mode === 'group' && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-text-primary">
              {t('chatInternal.fieldGroupName')}
            </span>
            <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          </label>
        )}

        {mode === 'group' && selectedMembers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedMembers.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-xs text-brand-800"
              >
                {m.name}
                <button
                  type="button"
                  onClick={() => toggleMember(m)}
                  aria-label={t('common.remove')}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-text-primary">
            {t('chatInternal.searchColleague')}
          </span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chatInternal.searchColleaguePlaceholder')}
          />
        </label>
        <ul className="max-h-56 overflow-y-auto rounded-lg border border-border">
          {results.length === 0 && (
            <li className="px-3 py-2 text-sm text-text-muted">{t('chatInternal.noResults')}</li>
          )}
          {results.map((u) => {
            const picked = mode === 'group' && selectedMembers.some((m) => m.id === u.id);
            return (
              <li key={u.id}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => (mode === 'direct' ? void pickDirect(u) : toggleMember(u))}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-sunken',
                    picked && 'bg-brand-50',
                  )}
                >
                  <span>
                    <span className="block text-sm text-text-primary">{u.name}</span>
                    <span className="block text-xs text-text-muted">{u.roleName}</span>
                  </span>
                  {picked && (
                    <span className="text-xs font-medium text-brand-700">
                      {t('chatInternal.selected')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

/**
 * Rename / member management / leave. `myRole` (from the conversation the
 * caller already listed as "mine") gates the admin-only controls IN THE UI
 * ONLY — the SAME actions are re-checked server-side by
 * `InternalChatService.assertAdmin`, which is the actual authority; a
 * member who forged a request here would still get a 403 (see the backend
 * report / migration 243).
 */
function ManageGroupModal({
  conversation,
  onClose,
  onLeave,
  onChanged,
}: {
  conversation: InternalConversation;
  onClose: () => void;
  onLeave: () => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const isAdmin = conversation.myRole === 'admin';

  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [name, setName] = useState(conversation.name ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const detail = await getConversationDetail(conversation.id);
      setParticipants(detail.participants);
      setName(detail.name ?? '');
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    }
  }, [conversation.id, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!isAdmin) return;
    const handle = setTimeout(() => {
      searchDirectory(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, isAdmin]);

  async function saveName() {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    try {
      await renameGroup(conversation.id, name.trim());
      await onChanged();
      await reload();
    } catch (err) {
      toast({
        title: errMsg(err, t('errors.generic')),
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function addMember(userId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await addGroupMember(conversation.id, userId);
      await onChanged();
      await reload();
    } catch (err) {
      toast({
        title: errMsg(err, t('errors.generic')),
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await removeGroupMember(conversation.id, userId);
      await onChanged();
      await reload();
    } catch (err) {
      toast({
        title: errMsg(err, t('errors.generic')),
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  const existingIds = new Set(participants.map((p) => p.userId));

  return (
    <Modal open onClose={onClose} title={t('chatInternal.manageGroup')}>
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-text-primary">
            {t('chatInternal.fieldGroupName')}
          </span>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin || busy}
            />
            {isAdmin && (
              <Button
                size="sm"
                onClick={() => void saveName()}
                loading={busy}
                disabled={name.trim() === ''}
              >
                {t('common.save')}
              </Button>
            )}
          </div>
          {!isAdmin && (
            <span className="mt-1 block text-xs text-text-muted">
              {t('chatInternal.onlyAdminCanManage')}
            </span>
          )}
        </label>

        <div>
          <p className="mb-1 text-sm font-medium text-text-primary">{t('chatInternal.members')}</p>
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-border">
            {participants.map((p) => (
              <li
                key={p.userId}
                className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
              >
                <span>
                  {p.name}
                  {p.role === 'admin' && (
                    <span className="ml-1 rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-text-muted">
                      {t('chatInternal.roleAdmin')}
                    </span>
                  )}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeMember(p.userId)}
                    className="text-xs text-danger-600 hover:underline"
                  >
                    {t('common.remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {isAdmin && (
          <div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-text-primary">
                {t('chatInternal.addMember')}
              </span>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('chatInternal.searchColleaguePlaceholder')}
              />
            </label>
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border">
              {results
                .filter((u) => !existingIds.has(u.id))
                .map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void addMember(u.id)}
                      className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-sunken"
                    >
                      <span>{u.name}</span>
                      <span className="text-xs text-text-muted">{u.roleName}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}

        <div className="flex justify-between border-t border-border pt-3">
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="danger" onClick={() => void onLeave()}>
            {t('chatInternal.leaveGroup')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
