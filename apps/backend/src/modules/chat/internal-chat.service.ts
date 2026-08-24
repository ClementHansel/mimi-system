import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_FORBIDDEN, ERR_NOT_FOUND, ERR_VALIDATION, type UUID } from '@mimi/shared';
import { MESSAGE_SELECT, mapMessage, type ChatMessage, type MessageRow } from './chat.service';

/**
 * Internal (staff-to-staff) chat — person-to-person and group. See migration
 * 243's header for the schema/RLS story; this is the layer the ticket calls
 * out explicitly: "authorisation must be enforced in the SERVICE, not only
 * by RLS and not only in the UI." Every method below re-checks the thing
 * RLS ALSO checks, on purpose:
 *
 *  - RLS decides which ROWS a query can touch at all (and, per convention,
 *    lets central roles see every conversation — see 243's header).
 *  - This service decides which ACTIONS a given caller may take, which is a
 *    stricter, per-conversation question RLS cannot express: "central roles
 *    may observe" is not "central roles may post as a member", "any
 *    participant may read" is not "any participant may rename the group".
 *    `assertActiveMember`/`assertAdmin` below query `chat_participants`
 *    directly for the ACTOR, never inferring membership from the fact that
 *    a row was merely visible.
 *
 * Messages are ordinary `chat_messages` rows reused from the WhatsApp
 * schema (`direction = 'outbound'`, `delivery_status = 'sent'` — there is
 * no gateway and no "us vs the contact" duality here, see 243). `mapMessage`
 * / `MESSAGE_SELECT` are imported from `chat.service.ts` rather than
 * re-derived, so the two chat surfaces can never quietly disagree on what a
 * message row looks like.
 *
 * NAMES NEVER COME FROM A DIRECT `users` QUERY. 009's `users_select` policy
 * hides every OTHER user's row from a non-central role — the exact gap
 * 212 already found and fixed for `kernel/approvals` via `app_user_display`
 * (SECURITY DEFINER, id/name/role_key only). This service reuses that same
 * function for every "resolve a name for this id" need (`namesFor()`), and
 * adds two narrower migration-243 functions for what 212's doesn't answer:
 * `app_chat_active_user_ids()` (is this id a currently-active user — for
 * validating someone BEFORE adding them) and `app_chat_directory()` (the
 * member-picker's fuzzy search). None of the three ever expose phone,
 * `pin_hash`, `password_hash`, or `last_login_at`.
 */

export interface InternalConversation {
  id: UUID;
  kind: 'direct' | 'group';
  /** Group name for a 'group' row; the OTHER participant's display name for a 'direct' row (computed, never stored — see 243). */
  name: string | null;
  myRole: 'member' | 'admin';
  participantCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** Computed from `chat_participants.last_read_at`, NOT `chat_conversations.unread_count` — that column is the WhatsApp thread's single-badge counter and is never written by this service (see 243/`sendMessage` below). */
  unreadCount: number;
}

export interface ChatParticipant {
  userId: UUID;
  name: string;
  role: 'member' | 'admin';
  joinedAt: string;
}

/** One entry in the "who can I message" directory — deliberately minimal (id/name/role label only, no HR data) since it is reachable by every role via `chat.read.own`. */
export interface DirectoryUser {
  id: UUID;
  name: string;
  roleName: string;
}

export interface InternalConversationDetail extends InternalConversation {
  participants: ChatParticipant[];
}

interface ConversationRow {
  id: string;
  kind: string;
  name: string | null;
  my_role: string;
  participant_count: string;
  last_message_at: Date | null;
  last_message_preview: string | null;
  unread_count: string;
  /** The OTHER active participant's user id, for 'direct' rows only — the name is resolved separately via `namesFor()`, never joined against `users` directly (see class header). */
  direct_peer_id: string | null;
}

/** `nameByUserId` resolves `direct_peer_id` to a display name — batched via `namesFor()`, one call for however many rows are being mapped, never a per-row `users` join. */
function mapConversation(
  r: ConversationRow,
  nameByUserId: Map<string, string>,
): InternalConversation {
  return {
    id: r.id as UUID,
    kind: r.kind as 'direct' | 'group',
    name:
      r.kind === 'direct'
        ? r.direct_peer_id
          ? (nameByUserId.get(r.direct_peer_id) ?? null)
          : null
        : r.name,
    myRole: r.my_role as 'member' | 'admin',
    participantCount: Number(r.participant_count),
    lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
    lastMessagePreview: r.last_message_preview,
    unreadCount: Number(r.unread_count),
  };
}

/**
 * Joins the CALLER's own (unfiltered here, filtered by the caller in WHERE)
 * `chat_participants` row as `mp` so every projected column — my role, my
 * unread count from MY read cursor, participant count, the direct peer's
 * id — is computed relative to whoever is asking. `WHERE mp.user_id = $n`
 * in each caller collapses this to exactly one row per conversation.
 */
const CONVERSATION_SELECT = `
  SELECT
    c.id, c.kind, c.name, mp.role AS my_role,
    c.last_message_at, c.last_message_preview,
    (SELECT COUNT(*) FROM chat_participants cp2
       WHERE cp2.conversation_id = c.id AND cp2.left_at IS NULL) AS participant_count,
    (SELECT COUNT(*) FROM chat_messages m
       WHERE m.conversation_id = c.id
         AND m.sender_user_id IS DISTINCT FROM mp.user_id
         AND m.occurred_at > COALESCE(mp.last_read_at, '-infinity'::timestamptz)) AS unread_count,
    CASE WHEN c.kind = 'direct' THEN (
      SELECT cp3.user_id FROM chat_participants cp3
       WHERE cp3.conversation_id = c.id AND cp3.left_at IS NULL AND cp3.user_id <> mp.user_id
       LIMIT 1
    ) END AS direct_peer_id
  FROM chat_conversations c
  JOIN chat_participants mp ON mp.conversation_id = c.id
`;

/** Preview column, not the message — same 120-char bound `chat.service.ts` uses for the WhatsApp inbox list. */
const PREVIEW_MAX = 120;

@Injectable()
export class InternalChatService {
  /** Conversations I am CURRENTLY (not formerly) an active participant of — leaving one removes it from this list, which is the whole point (see the integration spec). */
  async listMine(client: PoolClient, userId: UUID): Promise<InternalConversation[]> {
    const res = await client.query<ConversationRow>(
      `${CONVERSATION_SELECT}
        WHERE mp.user_id = $1 AND mp.left_at IS NULL AND c.kind IN ('direct', 'group')
        ORDER BY c.last_message_at DESC NULLS LAST`,
      [userId],
    );
    const names = await this.namesFor(
      client,
      res.rows.map((r) => r.direct_peer_id),
    );
    return res.rows.map((r) => mapConversation(r, names));
  }

  /**
   * Opens (or reuses) the ONE direct thread between two users. Race-safe by
   * construction (see migration 243's header on `direct_key`): both sides
   * of a simultaneous "open a DM" can run this concurrently and are
   * guaranteed to end up pointing at the same row, never two.
   */
  async openDirect(
    client: PoolClient,
    selfId: UUID,
    otherUserId: UUID,
  ): Promise<InternalConversation> {
    if (selfId === otherUserId) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'Cannot open a direct conversation with yourself',
      });
    }
    const active = await this.activeUserIds(client, [otherUserId]);
    if (!active.has(otherUserId)) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    }

    // Sorted so either side of the pair computes the identical key.
    const key = [selfId, otherUserId].sort().join(':');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO chat_conversations (kind, direct_key, created_by)
       VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) WHERE kind = 'direct' DO NOTHING
       RETURNING id`,
      [key, selfId],
    );

    let conversationId: string;
    if (inserted.rows[0]) {
      // Genuinely new — this call won the race (if there was one) and owns
      // seeding the two participant rows.
      conversationId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO chat_participants (conversation_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [conversationId, selfId, otherUserId],
      );
    } else {
      // Lost the race, or simply reopening an existing thread — either way
      // the row already exists and already has its participants.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM chat_conversations WHERE direct_key = $1 AND kind = 'direct'`,
        [key],
      );
      conversationId = existing.rows[0]!.id;
    }

    return this.requireConversation(client, conversationId, selfId);
  }

  /** The creator is seeded as `admin`; everyone named in `memberIds` joins as `member`. */
  async createGroup(
    client: PoolClient,
    creatorId: UUID,
    name: string,
    memberIds: UUID[],
  ): Promise<InternalConversation> {
    const others = Array.from(new Set(memberIds.filter((id) => id !== creatorId)));
    if (others.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A group needs at least one member besides its creator',
      });
    }
    const active = await this.activeUserIds(client, others);
    if (others.some((id) => !active.has(id))) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'One or more members do not exist or are inactive',
      });
    }

    const conv = await client.query<{ id: string }>(
      `INSERT INTO chat_conversations (kind, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [name, creatorId],
    );
    const conversationId = conv.rows[0]!.id;

    await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [conversationId, creatorId],
    );
    await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id, role)
       SELECT $1, uid, 'member' FROM unnest($2::uuid[]) AS uid`,
      [conversationId, others],
    );

    return this.requireConversation(client, conversationId, creatorId);
  }

  async renameGroup(
    client: PoolClient,
    actorId: UUID,
    conversationId: UUID,
    name: string,
  ): Promise<InternalConversation> {
    await this.requireGroup(client, conversationId);
    await this.assertAdmin(client, conversationId, actorId);
    await client.query(`UPDATE chat_conversations SET name = $2 WHERE id = $1`, [
      conversationId,
      name,
    ]);
    return this.requireConversation(client, conversationId, actorId);
  }

  /** Idempotent: re-adding someone already active in the group is a no-op, not a conflict — a retried request must not surface an error for an action that already succeeded. */
  async addMember(
    client: PoolClient,
    actorId: UUID,
    conversationId: UUID,
    newUserId: UUID,
  ): Promise<void> {
    await this.requireGroup(client, conversationId);
    await this.assertAdmin(client, conversationId, actorId);
    const active = await this.activeUserIds(client, [newUserId]);
    if (!active.has(newUserId)) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
    }
    await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (conversation_id, user_id) WHERE left_at IS NULL DO NOTHING`,
      [conversationId, newUserId],
    );
  }

  /**
   * Admin-only forcible removal of SOMEONE ELSE. Removing yourself goes
   * through `leaveGroup` instead — same underlying effect, but "a member may
   * only leave" (the ticket's own words) is a different action than "an
   * admin may remove", and collapsing them into one endpoint would let this
   * one silently double as a self-service leave with no admin check at all.
   */
  async removeMember(
    client: PoolClient,
    actorId: UUID,
    conversationId: UUID,
    targetUserId: UUID,
  ): Promise<void> {
    await this.requireGroup(client, conversationId);
    await this.assertAdmin(client, conversationId, actorId);
    if (targetUserId === actorId) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'Use the leave endpoint to remove yourself',
      });
    }
    const res = await client.query(
      `UPDATE chat_participants SET left_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, targetUserId],
    );
    if (res.rowCount === 0) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: 'That user is not a member of this group',
      });
    }
  }

  async leaveGroup(client: PoolClient, userId: UUID, conversationId: UUID): Promise<void> {
    await this.requireGroup(client, conversationId);
    const res = await client.query<{ role: string }>(
      `UPDATE chat_participants SET left_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
        RETURNING role`,
      [conversationId, userId],
    );
    const departingRole = res.rows[0]?.role;
    if (!departingRole) {
      throw new ForbiddenException({ code: ERR_FORBIDDEN, message: 'Not a member of this group' });
    }
    if (departingRole === 'admin') {
      // A group must not be left with zero admins able to rename it or
      // manage membership. Promote whichever active member has been in it
      // longest — the `NOT EXISTS` guard means this only ever fires when no
      // admin remains, so a group that still has one is untouched.
      await client.query(
        `UPDATE chat_participants SET role = 'admin'
          WHERE id = (
            SELECT id FROM chat_participants
             WHERE conversation_id = $1 AND left_at IS NULL
             ORDER BY joined_at ASC LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM chat_participants
             WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin'
          )`,
        [conversationId],
      );
    }
  }

  async getDetail(
    client: PoolClient,
    userId: UUID,
    conversationId: UUID,
  ): Promise<InternalConversationDetail> {
    const conversation = await this.requireConversation(client, conversationId, userId);
    // `chat_participants` only — no join against `users` here (see class
    // header). Names are resolved separately, in one batched call.
    const participants = await client.query<{ user_id: string; role: string; joined_at: Date }>(
      `SELECT cp.user_id, cp.role, cp.joined_at
         FROM chat_participants cp
        WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
        ORDER BY cp.joined_at ASC`,
      [conversationId],
    );
    const names = await this.namesFor(
      client,
      participants.rows.map((r) => r.user_id),
    );
    return {
      ...conversation,
      participants: participants.rows.map((r) => ({
        userId: r.user_id as UUID,
        name: names.get(r.user_id) ?? r.user_id,
        role: r.role as 'member' | 'admin',
        joinedAt: r.joined_at.toISOString(),
      })),
    };
  }

  /**
   * Existence-and-visibility only (no membership requirement beyond what
   * RLS already decided) — so a central role can read a group's history
   * per the convention in 243's header, while anyone RLS hides the row from
   * gets a loud 404 rather than a silent empty list indistinguishable from
   * "no messages yet".
   */
  async getMessages(
    client: PoolClient,
    _userId: UUID,
    conversationId: UUID,
  ): Promise<ChatMessage[]> {
    await this.requireInternalConversationExists(client, conversationId);
    const res = await client.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.conversation_id = $1 ORDER BY m.occurred_at ASC`,
      [conversationId],
    );
    return res.rows.map(mapMessage);
  }

  /**
   * Sending, unlike reading, requires GENUINE active membership —
   * `assertActiveMember` queries `chat_participants` for the SENDER
   * specifically, so a central role who can merely observe a conversation
   * (per RLS convention) cannot post into it as if they were a member.
   */
  async sendMessage(
    client: PoolClient,
    senderId: UUID,
    conversationId: UUID,
    body: string,
  ): Promise<ChatMessage> {
    await this.requireInternalConversationExists(client, conversationId);
    await this.assertActiveMember(client, conversationId, senderId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO chat_messages (conversation_id, direction, body, sender_user_id, delivery_status)
       VALUES ($1, 'outbound', $2, $3, 'sent')
       RETURNING id`,
      [conversationId, body, senderId],
    );
    // Deliberately NOT touching `chat_conversations.unread_count` or
    // `.status` — those belong to the WhatsApp thread's single-badge /
    // open-closed model (`ChatService.touchConversation`). Internal unread
    // is the per-participant `last_read_at` computed in `CONVERSATION_SELECT`
    // above; writing to that column here would give ONE conversation two
    // disagreeing unread counters.
    await client.query(
      `UPDATE chat_conversations SET last_message_at = NOW(), last_message_preview = $2 WHERE id = $1`,
      [conversationId, body.slice(0, PREVIEW_MAX)],
    );

    const res = await client.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [
      inserted.rows[0]!.id,
    ]);
    return mapMessage(res.rows[0]!);
  }

  async markRead(client: PoolClient, userId: UUID, conversationId: UUID): Promise<void> {
    await this.requireInternalConversationExists(client, conversationId);
    await this.assertActiveMember(client, conversationId, userId);
    await client.query(
      `UPDATE chat_participants SET last_read_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, userId],
    );
  }

  /**
   * The member-picker's data source: every OTHER active user, optionally
   * name-filtered. Deliberately not scoped by location or role — the whole
   * point of this feature is that a driver can message an accountant, not
   * only people who already share a location grant with them.
   */
  async searchDirectory(
    client: PoolClient,
    selfId: UUID,
    query: string | undefined,
  ): Promise<DirectoryUser[]> {
    const trimmed = query?.trim() ?? '';
    // `app_chat_directory` (243) — a SECURITY DEFINER bypass of `users_select`
    // (see class header), not a direct query against `users`: a non-central
    // caller's own `users_select` policy would otherwise return nothing but
    // their own row, and this endpoint exists specifically so a kasir or
    // driver CAN find a colleague to message.
    const res = await client.query<{ id: string; name: string; role_name: string }>(
      `SELECT * FROM app_chat_directory($1, $2)`,
      [selfId, trimmed],
    );
    return res.rows.map((r) => ({ id: r.id as UUID, name: r.name, roleName: r.role_name }));
  }

  // ── internal helpers ─────────────────────────────────────────────────────

  /**
   * Batched, bypass-RLS name lookup for a set of user ids, via 212's
   * `app_user_display` (id/name/role_key — reused rather than re-derived;
   * see class header). This is the ONLY way this service ever learns
   * another user's display name. `null` entries (no direct peer, e.g. a
   * group row) are filtered before the batch call.
   */
  private async namesFor(
    client: PoolClient,
    userIds: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = Array.from(new Set(userIds.filter((id): id is string => id !== null)));
    if (unique.length === 0) return new Map();
    const res = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM app_user_display($1::uuid[])`,
      [unique],
    );
    return new Map(res.rows.map((r) => [r.id, r.name]));
  }

  /**
   * Which of the given ids are CURRENTLY ACTIVE users, via migration 243's
   * `app_chat_active_user_ids` — separate from `namesFor`/`app_user_display`
   * on purpose: that function will happily name a DEACTIVATED account (the
   * right behaviour for showing history), which is exactly wrong for
   * deciding whether someone may be added to a new direct thread or group.
   */
  private async activeUserIds(client: PoolClient, userIds: readonly UUID[]): Promise<Set<string>> {
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) return new Set();
    const res = await client.query<{ id: string }>(
      `SELECT id FROM app_chat_active_user_ids($1::uuid[])`,
      [unique],
    );
    return new Set(res.rows.map((r) => r.id));
  }

  /** Full projection, scoped to MY OWN participation — used after create/rename/open, and by `listMine`/`getDetail`. Central-but-not-a-member callers get 404 here (see class header: observing is not the same as being listed as "mine"). */
  private async requireConversation(
    client: PoolClient,
    conversationId: string,
    userId: UUID,
  ): Promise<InternalConversation> {
    const res = await client.query<ConversationRow>(
      `${CONVERSATION_SELECT} WHERE c.id = $1 AND mp.user_id = $2 AND mp.left_at IS NULL`,
      [conversationId, userId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Conversation ${conversationId} not found`,
      });
    }
    const names = await this.namesFor(client, [row.direct_peer_id]);
    return mapConversation(row, names);
  }

  /** Runs on the caller's RLS-scoped client, so this is ALSO the "can this caller see it at all" check — a row RLS hides never comes back here regardless of `kind`. */
  private async requireInternalConversationExists(
    client: PoolClient,
    conversationId: string,
  ): Promise<{ kind: string }> {
    const res = await client.query<{ kind: string }>(
      `SELECT kind FROM chat_conversations WHERE id = $1 AND kind IN ('direct', 'group')`,
      [conversationId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Conversation ${conversationId} not found`,
      });
    }
    return row;
  }

  private async requireGroup(client: PoolClient, conversationId: string): Promise<void> {
    const { kind } = await this.requireInternalConversationExists(client, conversationId);
    if (kind !== 'group') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'This action only applies to groups',
      });
    }
  }

  private async assertAdmin(
    client: PoolClient,
    conversationId: string,
    userId: UUID,
  ): Promise<void> {
    const role = await this.activeRole(client, conversationId, userId);
    if (role !== 'admin') {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'Only a group admin can do this',
      });
    }
  }

  private async assertActiveMember(
    client: PoolClient,
    conversationId: string,
    userId: UUID,
  ): Promise<void> {
    const role = await this.activeRole(client, conversationId, userId);
    if (!role) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'Not a participant of this conversation',
      });
    }
  }

  private async activeRole(
    client: PoolClient,
    conversationId: string,
    userId: UUID,
  ): Promise<string | null> {
    const res = await client.query<{ role: string }>(
      `SELECT role FROM chat_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, userId],
    );
    return res.rows[0]?.role ?? null;
  }
}
