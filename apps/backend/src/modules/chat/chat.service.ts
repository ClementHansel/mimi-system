import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, type Paginated, type UUID } from '@mimi/shared';
import { WhatsAppChannelService } from '../../kernel/notification/channels/whatsapp-channel.service';

/**
 * Two-way chat over WhatsApp (W7).
 *
 * DELIVERY IS BORROWED, NOT REBUILT. Outbound messages go through the existing
 * `WhatsAppChannelService`, which already records every attempt in
 * `notification_outbox` and already no-ops when `WA_ENABLED=false`. Two things
 * follow, and both are deliberate:
 *
 *  1. Chat is safe to ship before the WA gateway credentials exist (RISK-P4).
 *     Messages are stored, threaded and visible in-app; they simply do not
 *     leave the building until the flag flips.
 *  2. A message the UI shows as sent is NEVER assumed delivered. Its
 *     `delivery_status` is whatever the channel actually reported, and the
 *     `outbox_id` points at the attempt. With WA disabled that status is
 *     `pending` — shown as such — rather than a green tick that lies.
 *
 * INBOUND arrives from n8n as a webhook (`receiveInbound`). It is idempotent on
 * the gateway's own message id, because a webhook that is retried after a slow
 * response is normal operation, not an error, and the alternative is duplicate
 * messages in a customer's thread.
 */

export interface ChatConversation {
  id: UUID;
  contactPhone: string;
  contactName: string | null;
  supplierId: UUID | null;
  userId: UUID | null;
  locationId: UUID | null;
  status: 'open' | 'closed';
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

export interface ChatMessage {
  id: UUID;
  conversationId: UUID;
  direction: 'inbound' | 'outbound';
  body: string;
  senderUserId: UUID | null;
  senderName: string | null;
  deliveryStatus: 'pending' | 'sent' | 'failed' | 'received';
  readAt: string | null;
  occurredAt: string;
}

interface ConversationRow {
  id: string;
  contact_phone: string;
  contact_name: string | null;
  supplier_id: string | null;
  user_id: string | null;
  location_id: string | null;
  status: string;
  last_message_at: Date | null;
  last_message_preview: string | null;
  unread_count: number;
}

/** Exported: `internal-chat.service.ts` (staff-to-staff chat, same physical table — see migration 243) reuses this shape and query verbatim rather than re-deriving it, so the two can never quietly diverge on what a message row looks like. */
export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  body: string;
  sender_user_id: string | null;
  sender_name: string | null;
  delivery_status: string;
  read_at: Date | null;
  occurred_at: Date;
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.contact_phone, c.contact_name, c.supplier_id, c.user_id, c.location_id,
         c.status, c.last_message_at, c.last_message_preview, c.unread_count
    FROM chat_conversations c
`;

export const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.direction, m.body, m.sender_user_id, u.name AS sender_name,
         m.delivery_status, m.read_at, m.occurred_at
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.sender_user_id
`;

/** The preview is a LIST column, not the message: one long paste must not stretch every row in the inbox. */
const PREVIEW_MAX = 120;

function mapConversation(r: ConversationRow): ChatConversation {
  return {
    id: r.id as UUID,
    contactPhone: r.contact_phone,
    contactName: r.contact_name,
    supplierId: r.supplier_id as UUID | null,
    userId: r.user_id as UUID | null,
    locationId: r.location_id as UUID | null,
    status: r.status as ChatConversation['status'],
    lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
    lastMessagePreview: r.last_message_preview,
    unreadCount: Number(r.unread_count),
  };
}

export function mapMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id as UUID,
    conversationId: r.conversation_id as UUID,
    direction: r.direction as ChatMessage['direction'],
    body: r.body,
    senderUserId: r.sender_user_id as UUID | null,
    senderName: r.sender_name,
    deliveryStatus: r.delivery_status as ChatMessage['deliveryStatus'],
    readAt: r.read_at ? r.read_at.toISOString() : null,
    occurredAt: r.occurred_at.toISOString(),
  };
}

/**
 * Strips a phone number to digits so `+62 811-2233` and `628112233` are the
 * same conversation. Without this the UNIQUE constraint is decorative: the
 * same person typed two ways would open two threads.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  // Indonesian numbers are written locally as `08…` and internationally as
  // `628…`; the gateway always reports the latter, so a locally-typed number
  // is converted rather than stored as a second identity for one person.
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly whatsapp: WhatsAppChannelService) {}

  async listConversations(
    client: PoolClient,
    query: { status?: string; page?: number; pageSize?: number },
  ): Promise<Paginated<ChatConversation>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    const params: unknown[] = [];
    let where = '';
    if (query.status) {
      params.push(query.status);
      where = `WHERE c.status = $1`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM chat_conversations c ${where}`,
      params,
    );
    const res = await client.query<ConversationRow>(
      `${CONVERSATION_SELECT} ${where}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return {
      rows: res.rows.map(mapConversation),
      total: Number.parseInt(countRes.rows[0]?.count ?? '0', 10),
      page,
      pageSize,
    };
  }

  async getMessages(client: PoolClient, conversationId: UUID): Promise<ChatMessage[]> {
    await this.requireConversation(client, conversationId);
    const res = await client.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.conversation_id = $1 ORDER BY m.occurred_at ASC`,
      [conversationId],
    );
    return res.rows.map(mapMessage);
  }

  /**
   * The caller's OWN thread with head office, created on first use.
   *
   * Separate from `listConversations` because it answers a different question
   * and is reachable with a different permission: every role holds
   * `chat.read.own`, almost none hold `chat.read`.
   */
  async getOwnConversation(
    client: PoolClient,
    userId: UUID,
  ): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
    const existing = await client.query<ConversationRow>(
      `${CONVERSATION_SELECT} WHERE c.user_id = $1 LIMIT 1`,
      [userId],
    );
    let row = existing.rows[0];

    if (!row) {
      // `users` carries its own `phone`; `employees` points AT users, not the
      // other way round, so there is no join to make here.
      const user = await client.query<{ name: string; phone: string | null }>(
        `SELECT u.name, u.phone FROM users u WHERE u.id = $1`,
        [userId],
      );
      const name = user.rows[0]?.name ?? 'Staff';
      // A staff member with no phone on file still gets a thread — it is
      // readable in-app by head office. The `user:` key keeps the UNIQUE
      // constraint satisfied without inventing a fake number that a later WA
      // send would try to deliver to.
      const phone = user.rows[0]?.phone
        ? normalisePhone(user.rows[0].phone)
        : `user:${userId.slice(0, 20)}`;
      const created = await client.query<ConversationRow>(
        `INSERT INTO chat_conversations (contact_phone, contact_name, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (contact_phone) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING id, contact_phone, contact_name, supplier_id, user_id, location_id,
                   status, last_message_at, last_message_preview, unread_count`,
        [phone, name, userId],
      );
      row = created.rows[0]!;
    }

    const conversation = mapConversation(row);
    const messages = await this.getMessages(client, conversation.id);
    return { conversation, messages };
  }

  /** Opens (or reuses) a thread with an arbitrary phone number — the inbox's "new message" path. */
  async openConversation(
    client: PoolClient,
    input: { phone: string; name?: string | null; supplierId?: UUID | null },
  ): Promise<ChatConversation> {
    const phone = normalisePhone(input.phone);
    const res = await client.query<ConversationRow>(
      `INSERT INTO chat_conversations (contact_phone, contact_name, supplier_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (contact_phone) DO UPDATE
         SET contact_name = COALESCE(EXCLUDED.contact_name, chat_conversations.contact_name),
             supplier_id  = COALESCE(EXCLUDED.supplier_id, chat_conversations.supplier_id)
       RETURNING id, contact_phone, contact_name, supplier_id, user_id, location_id,
                 status, last_message_at, last_message_preview, unread_count`,
      [phone, input.name ?? null, input.supplierId ?? null],
    );
    return mapConversation(res.rows[0]!);
  }

  /**
   * Sends a message. The row is written FIRST and the delivery attempted
   * second, so a gateway failure loses the delivery, never the message.
   */
  async sendMessage(
    client: PoolClient,
    conversationId: UUID,
    senderUserId: UUID,
    body: string,
  ): Promise<ChatMessage> {
    const conversation = await this.requireConversation(client, conversationId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO chat_messages (conversation_id, direction, body, sender_user_id, delivery_status)
       VALUES ($1, 'outbound', $2, $3, 'pending')
       RETURNING id`,
      [conversationId, body, senderUserId],
    );
    const messageId = inserted.rows[0]!.id;

    await this.touchConversation(client, conversationId, body, { incrementUnread: false });

    // A `user:`-keyed thread has no real number: it is an in-app thread for
    // staff without a phone on file, and attempting a WA send would be a
    // guaranteed failure recorded against a number that does not exist.
    if (!conversation.contactPhone.startsWith('user:')) {
      try {
        const result = await this.whatsapp.send(
          conversation.contactPhone,
          'chat.message',
          { body },
          body,
        );
        // `pending` and `failed` are different promises to the sender, and
        // which one applies depends on WHY the send did not succeed:
        //   - channel disabled (WA_ENABLED=false): nothing was attempted, the
        //     outbox row is a queue entry, so `pending` is the truth.
        //   - channel enabled and the gateway said no: someone tried and it
        //     did not go. Calling that `pending` shows a staff member a
        //     message apparently still on its way to a supplier who will never
        //     receive it — the exact dishonesty this module exists to avoid.
        const status = result.success ? 'sent' : this.whatsapp.isEnabled() ? 'failed' : 'pending';
        await client.query(
          `UPDATE chat_messages SET delivery_status = $2, outbox_id = $3 WHERE id = $1`,
          [messageId, status, result.outboxId],
        );
      } catch (err) {
        // The message stays; only its delivery failed. Swallowing this would
        // show the sender a message that silently never went anywhere.
        this.logger.error(
          `chat send failed for conversation ${conversationId}: ${(err as Error).message}`,
        );
        await client.query(`UPDATE chat_messages SET delivery_status = 'failed' WHERE id = $1`, [
          messageId,
        ]);
      }
    }

    const res = await client.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
    return mapMessage(res.rows[0]!);
  }

  /**
   * An inbound message from the gateway. Idempotent on `externalId`: a
   * redelivered webhook must not duplicate the thread.
   */
  async receiveInbound(
    client: PoolClient,
    input: { phone: string; body: string; externalId?: string | null; occurredAt?: string | null },
  ): Promise<{ conversationId: UUID; duplicate: boolean }> {
    const conversation = await this.openConversation(client, { phone: input.phone });

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO chat_messages
         (conversation_id, direction, body, external_id, delivery_status, occurred_at)
       VALUES ($1, 'inbound', $2, $3, 'received', COALESCE($4::timestamptz, NOW()))
       ON CONFLICT (external_id) DO NOTHING
       RETURNING id`,
      [conversation.id, input.body, input.externalId ?? null, input.occurredAt ?? null],
    );

    // No row means the constraint rejected a redelivery. Returning quietly is
    // correct — and importantly the conversation counters are NOT touched, or
    // a retried webhook would inflate the unread badge forever.
    if (inserted.rowCount === 0) return { conversationId: conversation.id, duplicate: true };

    await this.touchConversation(client, conversation.id, input.body, { incrementUnread: true });
    return { conversationId: conversation.id, duplicate: false };
  }

  /** Marks the thread's inbound messages read, and zeroes the badge in the same statement pair. */
  async markRead(client: PoolClient, conversationId: UUID): Promise<{ read: number }> {
    await this.requireConversation(client, conversationId);
    const res = await client.query(
      `UPDATE chat_messages SET read_at = NOW()
        WHERE conversation_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
      [conversationId],
    );
    await client.query(`UPDATE chat_conversations SET unread_count = 0 WHERE id = $1`, [
      conversationId,
    ]);
    return { read: res.rowCount ?? 0 };
  }

  async setStatus(
    client: PoolClient,
    conversationId: UUID,
    status: 'open' | 'closed',
  ): Promise<ChatConversation> {
    await this.requireConversation(client, conversationId);
    const res = await client.query<ConversationRow>(
      `UPDATE chat_conversations SET status = $2 WHERE id = $1
       RETURNING id, contact_phone, contact_name, supplier_id, user_id, location_id,
                 status, last_message_at, last_message_preview, unread_count`,
      [conversationId, status],
    );
    return mapConversation(res.rows[0]!);
  }

  private async touchConversation(
    client: PoolClient,
    conversationId: UUID,
    body: string,
    opts: { incrementUnread: boolean },
  ): Promise<void> {
    await client.query(
      `UPDATE chat_conversations
          SET last_message_at = NOW(),
              last_message_preview = $2,
              unread_count = CASE WHEN $3 THEN unread_count + 1 ELSE unread_count END,
              -- An inbound message reopens a closed thread: the customer
              -- replying after someone marked it done is exactly when it needs
              -- to come back to the top of the inbox.
              status = CASE WHEN $3 THEN 'open' ELSE status END
        WHERE id = $1`,
      [conversationId, body.slice(0, PREVIEW_MAX), opts.incrementUnread],
    );
  }

  private async requireConversation(
    client: PoolClient,
    conversationId: UUID,
  ): Promise<ChatConversation> {
    const res = await client.query<ConversationRow>(`${CONVERSATION_SELECT} WHERE c.id = $1`, [
      conversationId,
    ]);
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Conversation ${conversationId} not found`,
      });
    }
    return mapConversation(row);
  }
}
