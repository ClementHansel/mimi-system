-- =============================================================================
-- B-15 — replace the static-PIN approval check with one-time approval codes.
--
-- WHAT WAS WRONG: `POST /auth/pin/verify` accepted an arbitrary `userId`, read
-- that user under a central RLS bypass, and told the caller whether a guessed
-- 6-digit PIN was right — with no rate limit, no lockout and no audit row. Any
-- authenticated account could brute-force any other account's PIN, and that
-- same PIN backs offline authorization on tablets.
--
-- WHAT REPLACES IT (owner decisions, 2026-08-22):
--   Q8 — the code is GENERATED AT APPROVAL TIME and is single-use. Nobody
--        holds a standing secret, so there is no longer a static value that
--        repeated guessing can extract. Guessing a live code is guessing a
--        random 6 digits inside a 5-minute window, single-use, against a
--        caller-side attempt cap.
--   Q3 — a code is bound to ONE document (`document_type` + `document_id`),
--        so it cannot be minted speculatively or replayed onto another sale.
--   Q1 — it is issued by a user the approval state machine actually names as
--        an eligible approver for that document's current step, at that
--        location. Enforced in `ApprovalCodeService`, which reads
--        `eligibleActorsForAction` from `@mimi/shared` rather than restating
--        the rule.
--   Q4 — failures lock the CALLER (the person typing the code), never the
--        approver. Locking the target would have handed any kasir a way to
--        disable their supervisor mid-shift, which is the trade-off that
--        blocked the naive fix for weeks.
--   Q6 — a hard lock is cleared only by someone of HIGHER `ROLE_RANK` than
--        the locked user, so a locked kasir escalates to a supervisor, a
--        locked supervisor to a manager.
--
-- WHY A TABLE AND NOT REDIS: Redis is in the stack, but a code is evidence in
-- a money workflow — who authorised a void, when, and whether it was actually
-- used. That belongs in the database next to the approval it authorises, in
-- the same transaction, and has to survive a Redis flush. The volumes are
-- trivial (a handful of voids per outlet per day).
-- =============================================================================

BEGIN;

CREATE TABLE approval_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Q3's binding. Deliberately NOT a FK to `approvals(id)`: the code names the
  -- DOCUMENT the way every other approval-adjacent lookup in this codebase
  -- does (`approvals.document_type`/`document_id`), so issuing and redeeming
  -- both resolve through the same key the kernel already uses.
  document_type VARCHAR(50) NOT NULL,
  document_id UUID NOT NULL,
  location_id UUID REFERENCES locations(id),

  -- The approver. The decision recorded when this code is redeemed is THEIRS,
  -- not the redeemer's — which is the whole point: a kasir types the code, but
  -- the ledger, the audit row and the approval step all name the supervisor
  -- who authorised it. `issued_by_role` is snapshotted rather than joined at
  -- read time, because a later role change must not rewrite who approved what.
  issued_by_user_id UUID NOT NULL REFERENCES users(id),
  issued_by_role VARCHAR(30) NOT NULL,

  -- Who may type it in. A code in anyone else's hands is inert, so intercepting
  -- one (overheard, forwarded, screenshotted) is not enough on its own.
  redeemable_by_user_id UUID NOT NULL REFERENCES users(id),

  -- argon2id PHC, the same primitive and parameters as `users.pin_hash`
  -- (`pin-hash.util.ts`, SYNC-PROTOCOL §7.2). A 6-digit code is low-entropy,
  -- so it is never stored in the clear — a database read must not hand over
  -- a live authorization.
  code_hash VARCHAR(255) NOT NULL,

  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'consumed', 'superseded', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A consumed code must record when. Cheap invariant, and it is the column a
  -- fraud question ("was this code ever actually used?") is answered from.
  CONSTRAINT approval_codes_consumed_at_present
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);

-- At most ONE live code per document. Re-issuing supersedes the previous one
-- (the service flips it to 'superseded' in the same transaction) rather than
-- leaving two valid codes in the air — two live codes for one void means two
-- chances to guess and an ambiguous answer to "who approved it".
--
-- The predicate is `state = 'active'` and not `expires_at > NOW()`, because
-- NOW() is not immutable and cannot appear in an index predicate. Expiry is
-- therefore enforced in the query, and a lapsed row is swept to 'expired'
-- lazily on the next issue for that document.
CREATE UNIQUE INDEX uq_approval_codes_one_active
  ON approval_codes (document_type, document_id)
  WHERE state = 'active';

CREATE INDEX idx_approval_codes_redeemer ON approval_codes (redeemable_by_user_id, state);
CREATE INDEX idx_approval_codes_issuer ON approval_codes (issued_by_user_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Central roles see everything (head office investigating a void). Otherwise a
-- row is visible only to the two people it concerns: the approver who issued
-- it and the person who may redeem it. Location is deliberately NOT a
-- visibility axis here — a supervisor covering an outlet remotely (the exact
-- case Q2 exists for: an unscheduled shift change, someone off sick) issues
-- codes for a location they may not hold in `user_locations`.
--
-- `code_hash` is never selected by any read path; see `ApprovalCodeRepository`,
-- which returns it only to the verify call itself.
ALTER TABLE approval_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_codes_scope ON approval_codes FOR ALL
  USING (
    app_is_central()
    OR app_is_self(issued_by_user_id)
    OR app_is_self(redeemable_by_user_id)
  )
  WITH CHECK (
    app_is_central()
    OR app_is_self(issued_by_user_id)
    OR app_is_self(redeemable_by_user_id)
  );

-- =============================================================================
-- Caller lockouts (Q4/Q5/Q6).
--
-- One row per user, created on first failure. `failed_count` counts failures
-- inside a rolling window; crossing the cap sets `hard_locked`, which only a
-- higher-ranked user can clear. A successful redemption resets the row, so
-- ordinary fat-fingering never accumulates toward a lock across a whole shift.
--
-- `locked_until` carries the SHORT progressive backoff (attempts 3 and 4);
-- `hard_locked` is the terminal state. Two columns rather than one far-future
-- timestamp, so "wait 30 seconds" and "go find your supervisor" are
-- distinguishable both to the UI and to anyone reading the table.
-- =============================================================================

CREATE TABLE auth_lockouts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ,
  -- Short backoff. NULL when not currently backing off.
  locked_until TIMESTAMPTZ,
  -- Terminal lock; cleared only by `POST /api/auth/lockouts/:userId/clear`.
  hard_locked BOOLEAN NOT NULL DEFAULT FALSE,
  hard_locked_at TIMESTAMPTZ,
  cleared_by_user_id UUID REFERENCES users(id),
  cleared_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT auth_lockouts_hard_locked_at_present
    CHECK (hard_locked = (hard_locked_at IS NOT NULL))
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth_lockouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_auth_lockouts_hard ON auth_lockouts (hard_locked) WHERE hard_locked;

-- A user may always read their OWN lock state — the till has to be able to say
-- "locked, ask your supervisor" rather than failing with a bare 403. Central
-- roles see every row; the rank check that governs who may CLEAR one is a
-- service-level rule (`ROLE_RANK`), not something RLS can express.
ALTER TABLE auth_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_lockouts FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_lockouts_scope ON auth_lockouts FOR ALL
  USING (app_is_central() OR app_is_self(user_id))
  WITH CHECK (app_is_central() OR app_is_self(user_id));

-- `mimi_app` holds no blanket table privileges (009), so every new table grants
-- explicitly — same as 221's `sj_positions` and 225's chat tables.
GRANT SELECT, INSERT, UPDATE ON approval_codes TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_lockouts TO app_user;

COMMIT;
