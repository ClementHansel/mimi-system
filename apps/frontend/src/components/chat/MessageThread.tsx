'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, Send } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, EmptyState, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { ChatMessage } from './lib/chat-api';

/**
 * The message list plus composer, shared by the admin inbox and the staff
 * "chat with head office" screen — the two differ in which thread they load
 * and who may read it, not in how a conversation looks.
 *
 * DELIVERY STATE IS SHOWN, NOT ASSUMED. With `WA_ENABLED=false` every outbound
 * message stays `pending` forever, so a UI that drew a sent tick on submit
 * would tell every user their message had gone when nothing left the building.
 * Pending renders as a clock with a plain explanation; failed renders as a
 * warning. Only a status the SERVER reported as sent shows as sent.
 */
export function MessageThread({
  messages,
  onSend,
  disabled = false,
  emptyTitle,
}: {
  messages: ChatMessage[];
  onSend: (body: string) => Promise<void>;
  disabled?: boolean;
  emptyTitle: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Jump to the newest message, the way every chat behaves. `auto` rather
    // than smooth: on opening a long thread a smooth scroll is a visible
    // several-second crawl through someone else's history.
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function submit() {
    const body = draft.trim();
    if (body === '' || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <EmptyState title={emptyTitle} />
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg px-3 py-2',
                    m.direction === 'outbound'
                      ? 'bg-brand-500 text-white'
                      : 'bg-surface-sunken text-text-primary',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
                  <p
                    className={cn(
                      'mt-1 flex items-center gap-1 text-[11px]',
                      m.direction === 'outbound' ? 'text-white/75' : 'text-text-muted',
                    )}
                  >
                    <span>{fmtTime(m.occurredAt)}</span>
                    {m.senderName && m.direction === 'outbound' && <span>· {m.senderName}</span>}
                    {m.direction === 'outbound' && m.deliveryStatus === 'pending' && (
                      <span className="inline-flex items-center gap-0.5">
                        · <Clock className="size-3" aria-hidden />
                        {t('chat.status.pending')}
                      </span>
                    )}
                    {m.direction === 'outbound' && m.deliveryStatus === 'failed' && (
                      <span className="inline-flex items-center gap-0.5">
                        · <AlertTriangle className="size-3" aria-hidden />
                        {t('chat.status.failed')}
                      </span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-border p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the convention every
            // messaging app uses, so muscle memory does the right thing.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          disabled={disabled || sending}
          placeholder={t('chat.composerPlaceholder')}
          aria-label={t('chat.composerPlaceholder')}
          // `wrapperClassName`, not `className`. `Textarea` renders a wrapper
          // <div> around the <textarea> (for the label and error slots), and the
          // wrapper is what sits in this flex row — so `flex-1` on the inner
          // element grew nothing and left the composer at its intrinsic width:
          // a ~330px box with its own scrollbar and a placeholder clipped
          // mid-sentence, next to a mostly empty message pane.
          wrapperClassName="flex-1"
          className="resize-none"
        />
        <Button
          onClick={() => void submit()}
          loading={sending}
          disabled={disabled || draft.trim() === ''}
          leftIcon={<Send className="size-4" />}
          // Never squeezed by a long draft; the label must stay readable.
          className="flex-none"
        >
          {t('chat.send')}
        </Button>
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('id-ID', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
