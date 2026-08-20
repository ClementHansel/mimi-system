-- =============================================================================
-- Two-way chat, delivered over WhatsApp (owner request 2026-08-20).
--
-- WHAT THIS IS NOT: `notification_outbox` already exists and already sends
-- WhatsApp — but it is a fire-and-forget TEMPLATED NOTIFICATION log ("an
-- approval is waiting for you"), keyed by template and recipient, with no
-- notion of a reply, a thread, or who said what to whom. A conversation is a
-- different shape, so it gets its own tables rather than being bolted onto a
-- log whose whole design assumes one-way traffic.
--
-- The two stay connected at the delivery layer: an outbound chat message is
-- still SENT through `WhatsAppChannelService`, so it still lands in
-- `notification_outbox` and still respects `WA_ENABLED=false`. That means chat
-- is safe to ship before the WA gateway credentials exist (RISK-P4): messages
-- are stored and visible in-app, and simply do not leave the building until
-- the flag flips. `chat_messages.outbox_id` is the join back to the delivery
-- attempt.
-- =============================================================================

BEGIN;

CREATE TABLE chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- E.164 without the '+' (`6281…`), matching what the WA gateway hands back.
  -- UNIQUE because a phone number IS the conversation: a second thread with
  -- the same person is a bug, not a feature.
  contact_phone VARCHAR(30) UNIQUE NOT NULL,
  contact_name VARCHAR(255),
  -- Optional links to who this is, when we know. Nullable on purpose: a
  -- stranger messaging the outlet number is still a conversation, and refusing
  -- to store it until someone classifies it would lose the message.
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Reporting/scope dimension. NULL = head office, which is also what an
  -- unclassified inbound conversation gets.
  location_id UUID REFERENCES locations(id),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Denormalised for the inbox list: ordering threads by "most recent message"
  -- is the entire point of an inbox, and doing it with a correlated subquery
  -- over `chat_messages` on every load is the obvious way to make it slow.
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_chat_conversations_recent ON chat_conversations (status, last_message_at DESC);
CREATE INDEX idx_chat_conversations_location ON chat_conversations (location_id);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body TEXT NOT NULL,
  -- Who typed it. NULL for inbound (the contact is not a system user) and for
  -- anything the system itself sends.
  sender_user_id UUID REFERENCES users(id),
  -- Idempotency. The gateway may redeliver a webhook, and a retried send must
  -- not duplicate the thread. UNIQUE rather than "best effort dedupe in the
  -- service", because the constraint is the only version that holds under two
  -- concurrent deliveries.
  external_id VARCHAR(128) UNIQUE,
  -- The `notification_outbox` row this went out through, so a message shown as
  -- sent in-app can always be traced to whether it actually left.
  outbox_id UUID REFERENCES notification_outbox(id),
  delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'received')),
  read_at TIMESTAMPTZ,
  -- The moment the message happened (gateway timestamp for inbound), which is
  -- NOT necessarily when we stored it: an inbound webhook can arrive minutes
  -- late and must still thread in the right order.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_thread ON chat_messages (conversation_id, occurred_at);
CREATE INDEX idx_chat_messages_unread ON chat_messages (conversation_id)
  WHERE direction = 'inbound' AND read_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Central roles see every conversation; a location-scoped role sees the
-- conversations attached to a location it holds, plus unclassified ones
-- (`location_id IS NULL`), because an inbound message from a stranger has no
-- location yet and hiding it from everyone but head office would mean nobody
-- at the outlet it concerns ever answers it.
--
-- A user ALWAYS sees their own conversation (`user_id`), which is what makes
-- the staff-facing "chat with head office" view work for a driver or kasir who
-- holds no location scope at all.
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_conversations_scope ON chat_conversations FOR ALL
  USING (
    app_is_central()
    OR (location_id IS NOT NULL AND app_has_location(location_id))
    OR location_id IS NULL
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    app_is_central()
    OR (location_id IS NOT NULL AND app_has_location(location_id))
    OR location_id IS NULL
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Messages inherit their conversation's visibility rather than restating it:
-- one rule, so the two can never disagree about who may read a thread.
CREATE POLICY chat_messages_scope ON chat_messages FOR ALL
  USING (
    EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_messages.conversation_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_messages.conversation_id)
  );

-- Without these the runtime role cannot touch the tables at all: `mimi_app`
-- holds no blanket table privileges by design (009), so every new table grants
-- explicitly, exactly as `sj_positions` does in 221.
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO app_user;

COMMIT;
