import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageThread } from './MessageThread';
import type { ChatMessage } from './lib/chat-api';

/**
 * The one thing worth testing about a chat UI shipped before its gateway
 * exists: that it never claims a message was delivered.
 *
 * With `WA_ENABLED=false` every outbound message stays `pending` forever. A
 * thread that drew a sent tick on submit would tell every user their message
 * had gone when nothing left the building — a silent failure, and the reason
 * this feature is risky to ship blind at all.
 */
function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: over.id ?? 'm1',
    conversationId: 'c1',
    direction: 'outbound',
    body: 'Halo',
    senderUserId: 'u1',
    senderName: 'Owner',
    deliveryStatus: 'pending',
    readAt: null,
    occurredAt: '2026-08-20T03:00:00.000Z',
    ...over,
  };
}

describe('MessageThread delivery state', () => {
  it('labels an undelivered outbound message as NOT sent', () => {
    render(<MessageThread messages={[msg({})]} onSend={vi.fn()} emptyTitle="kosong" />);
    expect(screen.getByText(/Belum terkirim/)).toBeInTheDocument();
  });

  it('labels a failed message as failed', () => {
    render(
      <MessageThread
        messages={[msg({ deliveryStatus: 'failed' })]}
        onSend={vi.fn()}
        emptyTitle="kosong"
      />,
    );
    expect(screen.getByText(/Gagal kirim/)).toBeInTheDocument();
  });

  it('adds no delivery caveat once the server reports it sent', () => {
    render(
      <MessageThread
        messages={[msg({ deliveryStatus: 'sent' })]}
        onSend={vi.fn()}
        emptyTitle="kosong"
      />,
    );
    expect(screen.queryByText(/Belum terkirim/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Gagal kirim/)).not.toBeInTheDocument();
  });

  it('never puts a delivery caveat on an INBOUND message — we did not send it', () => {
    render(
      <MessageThread
        messages={[msg({ direction: 'inbound', deliveryStatus: 'received', senderName: null })]}
        onSend={vi.fn()}
        emptyTitle="kosong"
      />,
    );
    expect(screen.queryByText(/Belum terkirim/)).not.toBeInTheDocument();
  });

  it('shows the empty state rather than a blank panel', () => {
    render(<MessageThread messages={[]} onSend={vi.fn()} emptyTitle="Belum ada pesan" />);
    expect(screen.getByText('Belum ada pesan')).toBeInTheDocument();
  });
});
