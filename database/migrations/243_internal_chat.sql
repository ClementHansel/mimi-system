-- =============================================================================
-- Internal staff chat: person-to-person and group messaging (owner request
-- 2026-08-24).
--
-- WHY: staff need to message each other inside the app. Scraping every
-- employee's personal WhatsApp is not viable, so this has to be first-class
-- rather than another workaround.
--
-- `chat_conversations` / `chat_messages` (225) already exist, but they are
-- WHATSAPP-SHAPED: one row per external `contact_phone`, `direction` is a
-- two-party `inbound`/`outbound` label, and `delivery_status` tracks a real
-- WA gateway send. None of that generalises to "three cooks in a group
-- chat", so this migration teaches the EXISTING tables a second shape
-- rather than building a parallel set: `kind` says which shape a row is.
-- The WhatsApp inbox (chat.controller.ts / chat.service.ts, both untouched
-- by this migration) keeps working exactly as before — every existing row
-- backfills to `kind = 'whatsapp'` via the column DEFAULT (PG11+ populates a
-- new column's default for existing rows without a table rewrite, so this
-- is not a manual UPDATE), and every existing WhatsApp query and policy
-- keeps returning exactly what it always did.
--
-- WHAT'S NEW ON `chat_conversations`:
--   - `contact_phone` goes from `NOT NULL` to nullable — 225 assumed every
--     row is a WhatsApp thread with a real phone number; a 'direct'/'group'
--     row has none. A CHECK constraint pins the invariant instead of
--     leaving it implicit: `whatsapp` rows always have a phone, internal
--     rows never do. Every EXISTING row already satisfies this (they are
--     all 'whatsapp' with a real `contact_phone`), so the constraint is
--     added, not just declared, and this migration would fail loudly on
--     apply if that were somehow not true.
--   - `kind` ('whatsapp' | 'direct' | 'group') — the discriminator.
--   - `name` / `created_by` — group metadata. NULL for 'whatsapp' and
--     'direct' rows (a direct thread's "name" is the OTHER participant,
--     computed by the service from `chat_participants`, not stored).
--   - `direct_key` — a deterministic pairing of the two participants'
--     user ids (sorted so "A opens a DM with B" and "B opens with A" write
--     the identical key), UNIQUE among 'direct' rows only. This is what
--     makes "open a DM with user X" race-safe: two people opening the same
--     DM at the same instant both attempt the same INSERT; one wins, the
--     other's `ON CONFLICT` finds the winner's row instead of creating a
--     second thread. A service-side "check then insert" cannot close this
--     race — both requests can pass the check before either commits.
--
-- `chat_participants` IS NEW: who is in a 'direct'/'group' conversation,
-- with what standing (`member`/`admin`), `joined_at`, `left_at` (nullable —
-- NULL means "currently in it"; set, never deleted, on leaving, so the row
-- stays a historical record of who was ever in the thread and every
-- message's sender still resolves to a real membership), and
-- `last_read_at` — the PER-PARTICIPANT read cursor group chat actually
-- needs. `chat_messages.read_at` is a single flag and is UNCHANGED — correct
-- for a one-contact WhatsApp thread, meaningless for a group where "read" is
-- not one bit shared by everyone.
--
-- MESSAGES TABLE IS UNCHANGED. An internal message is an ordinary
-- `chat_messages` row with `direction = 'outbound'` (there is no "inbound
-- side" in a staff conversation — everyone who writes is "us") and
-- `delivery_status = 'sent'` immediately: there is no gateway to wait on,
-- and the moment it is committed it IS visible in-app to every other
-- participant, which is what "sent" means for this kind. `outbox_id` and
-- `external_id` stay NULL.
--
-- RLS — THE SECURITY-CRITICAL PART OF THIS TICKET:
-- 225's original `chat_conversations_scope` grants access to ANY row with
-- `location_id IS NULL` — correct for an unclassified WhatsApp lead nobody
-- has triaged, but 'direct'/'group' rows are ALWAYS `location_id IS NULL`
-- (an internal chat has no location), so leaving that clause in place for
-- them would let ANY authenticated user read ANY staff conversation — worse
-- than "readable by someone who merely shares a location", the exact
-- failure this ticket calls out, since it would be readable by literally
-- everyone, sharing nothing at all. So the old policy is split in two:
--   - `chat_conversations_whatsapp_scope`: 225's logic, byte-for-byte,
--     narrowed to `kind = 'whatsapp'`.
--   - `chat_conversations_internal_scope`: `kind IN ('direct','group')`,
--     gated on MEMBERSHIP or `created_by` — never on location.
--
-- Central roles (`app_is_central()`) still see every conversation,
-- including internal ones. That is not a LOOSER rule than what already
-- exists — it is the SAME breadth 225 already gives them over the WhatsApp
-- inbox, applied consistently rather than invented fresh, per this ticket's
-- instruction to follow the existing convention. Nothing in this migration
-- or the service built on top of it actually EXPOSES an "every staff
-- conversation" endpoint to central roles though (see the backend report) —
-- the breadth is latent at the RLS layer only, matching the WhatsApp
-- table's own precedent, and flagged loudly so the owner can narrow it if
-- head-office visibility into staff DMs was not actually wanted.
--
-- CROSS-TABLE RLS RECURSION (see 201's header — this codebase has hit this
-- exact class of bug before, between `surat_jalan` and `sj_drops`): if
-- `chat_conversations`'s policy queried `chat_participants` directly, AND
-- `chat_participants`'s policy queried `chat_conversations` directly, that
-- is a mutual cycle and Postgres raises "infinite recursion detected in
-- policy" the moment either table is queried by a non-owner role. Fixed the
-- same way 201 fixed it: `app_chat_is_active_participant()` is a
-- SECURITY DEFINER helper that reads `chat_participants` bypassing ITS row
-- security, so `chat_conversations`'s policy can ask "is this user an
-- active participant" without ever going back through
-- `chat_participants_scope`. `chat_participants_scope` then safely queries
-- `chat_conversations` directly (one direction only — the exact shape
-- `chat_messages_scope` already uses against `chat_conversations`, proven
-- safe by 225).
--
-- A SEPARATE PROBLEM, FOUND WHILE BUILDING THE SERVICE ON TOP OF THIS, BUT
-- ALREADY A KNOWN CLASS OF BUG HERE (212's header tells the story in full):
-- 009's `users_select` restricts a non-central role to seeing only ITS OWN
-- `users` row. 212 already hit this exact shape for `kernel/approvals`'
-- "my pending approvals" inbox (a Supervisor/Kepala Gudang session joining
-- `users` to show a requester's name got rows silently dropped) and fixed
-- it with `app_user_display(uuid[])` — SECURITY DEFINER, id/name/role_key
-- only, `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO app_user`. Internal
-- chat hits the SAME gap for the SAME reason (a kasir or driver could not
-- even learn a colleague's display name, let alone pick one to message —
-- breaking this feature for exactly the staff who most need it), so it
-- REUSES `app_user_display` for every "resolve a name for this id" need
-- (`getDetail`'s participant list, a direct thread's peer name) rather than
-- minting a near-duplicate function.
--
-- What 212's function CANNOT answer is "is this id a currently-active
-- user" (it returns a row for anyone who ever existed, active or not —
-- correct for showing history, wrong for validating a NEW member to add).
-- The directory search (name + a human role LABEL, fuzzy-matched, capped at
-- 20) is also a different question again. Two narrow ADDITIONS, following
-- 212's exact convention (SECURITY DEFINER, `REVOKE ALL FROM PUBLIC` +
-- explicit `GRANT EXECUTE TO app_user` since these also touch `users`):
-- `app_chat_active_user_ids()` (id only, active only) and
-- `app_chat_directory()` (id/name/role-label only). Neither ever exposes
-- email, phone, `pin_hash`, `password_hash`, or `last_login_at` — the exact
-- boundary 212 already drew, held to here too.
-- =============================================================================

BEGIN;

-- `contact_phone` (225) is `UNIQUE NOT NULL` — correct when every row WAS a
-- WhatsApp thread, wrong now: a 'direct'/'group' row has no phone number at
-- all. Dropped to nullable (multiple NULLs are fine under a plain UNIQUE
-- constraint — they are never considered equal to each other), and the new
-- CHECK below pins the invariant explicitly rather than leaving it to
-- application code to remember: a 'whatsapp' row always has one, an
-- internal row never does.
ALTER TABLE chat_conversations
  ALTER COLUMN contact_phone DROP NOT NULL,
  ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'whatsapp'
    CHECK (kind IN ('whatsapp', 'direct', 'group')),
  ADD COLUMN name VARCHAR(255),
  ADD COLUMN created_by UUID REFERENCES users(id),
  ADD COLUMN direct_key TEXT,
  ADD CONSTRAINT chat_conversations_kind_phone_chk CHECK (
    (kind = 'whatsapp' AND contact_phone IS NOT NULL) OR
    (kind IN ('direct', 'group') AND contact_phone IS NULL)
  );

-- Partial: only 'direct' rows ever populate `direct_key`, and only among
-- themselves must it be unique — every 'whatsapp'/'group' row's NULL here
-- is unconstrained, as NULLs always are under a unique index.
CREATE UNIQUE INDEX idx_chat_conversations_direct_key
  ON chat_conversations (direct_key) WHERE kind = 'direct';

CREATE INDEX idx_chat_conversations_kind ON chat_conversations (kind);

CREATE TABLE chat_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = currently in the conversation. Set, never deleted, when someone
  -- leaves or is removed — see header.
  left_at TIMESTAMPTZ,
  -- Per-participant read cursor (see header). NULL = never opened the thread.
  last_read_at TIMESTAMPTZ
);

-- At most ONE *active* row per (conversation, user). Partial rather than a
-- plain UNIQUE(conversation_id, user_id): re-joining a group after leaving
-- is a NEW row (history stays intact on the old one) and would otherwise
-- collide with the row it left behind.
CREATE UNIQUE INDEX idx_chat_participants_active
  ON chat_participants (conversation_id, user_id) WHERE left_at IS NULL;

-- "Which conversations is this user currently in" — every list/lookup this
-- feature does.
CREATE INDEX idx_chat_participants_user ON chat_participants (user_id) WHERE left_at IS NULL;

-- ── RLS helper (see header: breaks the chat_conversations <-> chat_participants cycle) ──

CREATE FUNCTION app_chat_is_active_participant(p_conversation_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_participants cp
     WHERE cp.conversation_id = p_conversation_id
       AND cp.user_id = p_user_id
       AND cp.left_at IS NULL
  );
$$;

-- ── RLS helpers: the `users_select` carve-out (see header) ─────────────────
-- Name resolution for a KNOWN set of ids reuses 212's `app_user_display`
-- directly (imported into `internal-chat.service.ts`'s queries) — no new
-- function needed for that. The two below cover what it does not:

-- "Which of these ids are CURRENTLY ACTIVE users" — existence + active-flag
-- only, no name, no other column. Used to validate a direct-message target
-- or a new group member before inserting a `chat_participants` row for
-- them; deliberately separate from `app_user_display` because that
-- function answers a different question (display an id that already IS a
-- participant, active or not) and conflating the two would mean silently
-- letting a deactivated account be added to a NEW group.
CREATE FUNCTION app_chat_active_user_ids(p_user_ids UUID[])
RETURNS TABLE(id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id FROM users u WHERE u.id = ANY(p_user_ids) AND u.is_active;
$$;

REVOKE ALL ON FUNCTION app_chat_active_user_ids(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_chat_active_user_ids(UUID[]) TO app_user;

-- The member-picker's search: name + role LABEL (not the role key — this is
-- for a human choosing who to message, not an authorization decision),
-- every OTHER active user, optionally name-filtered, capped at 20 rows so a
-- one-letter query cannot return the entire company.
CREATE FUNCTION app_chat_directory(p_self UUID, p_query TEXT)
RETURNS TABLE(id UUID, name TEXT, role_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.name, r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
   WHERE u.is_active
     AND u.id <> p_self
     AND (p_query = '' OR u.name ILIKE '%' || p_query || '%')
   ORDER BY u.name
   LIMIT 20;
$$;

REVOKE ALL ON FUNCTION app_chat_directory(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_chat_directory(UUID, TEXT) TO app_user;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY chat_conversations_scope ON chat_conversations;

-- 225's original policy, unchanged in effect, narrowed to the rows it was
-- ever meant for.
CREATE POLICY chat_conversations_whatsapp_scope ON chat_conversations FOR ALL
  USING (
    kind = 'whatsapp'
    AND (
      app_is_central()
      OR (location_id IS NOT NULL AND app_has_location(location_id))
      OR location_id IS NULL
      OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    kind = 'whatsapp'
    AND (
      app_is_central()
      OR (location_id IS NOT NULL AND app_has_location(location_id))
      OR location_id IS NULL
      OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

-- Membership, not location (see header).
--
-- `created_by = <self>` covers the one moment membership cannot yet: the
-- instant a conversation row is INSERTed, before its `chat_participants`
-- rows exist. It compares the row's OWN column (available directly in
-- USING/WITH CHECK, no subquery) rather than re-querying
-- `chat_conversations` for itself — which, for an INSERT, would not see its
-- own uncommitted row anyway.
CREATE POLICY chat_conversations_internal_scope ON chat_conversations FOR ALL
  USING (
    kind IN ('direct', 'group')
    AND (
      app_is_central()
      OR created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
      OR app_chat_is_active_participant(id, NULLIF(current_setting('app.user_id', true), '')::uuid)
    )
  )
  WITH CHECK (
    kind IN ('direct', 'group')
    AND (
      app_is_central()
      OR created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
      OR app_chat_is_active_participant(id, NULLIF(current_setting('app.user_id', true), '')::uuid)
    )
  );

-- `chat_messages_scope` (225) already reads through to whichever
-- `chat_conversations` policy applies via its own EXISTS subquery — a
-- message inherits its conversation's (now membership-based, for internal
-- rows) visibility automatically. Nothing to change there.

-- Participant-list visibility mirrors the conversation's: if you can see
-- the conversation (central, creator-before-first-participant-row, or an
-- active member), you can see who else is in it. Queries
-- `chat_conversations` directly — safe, one direction only, the same shape
-- `chat_messages_scope` already uses (see header on recursion).
CREATE POLICY chat_participants_scope ON chat_participants FOR ALL
  USING (
    EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_participants.conversation_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_participants.conversation_id)
  );

-- Without this the runtime role cannot touch the table at all (009): every
-- new table grants explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_participants TO app_user;

COMMIT;
