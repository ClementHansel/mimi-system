-- Migration: 206_w1c_offline_credential_verification_lookup
-- Fix block: 2xx. Genuine blocker found live by W2-D: offline_credentials'
--             RLS policy is SELF-only (CONTRACTS.md §1.14: "sessions,
--             offline_credentials | yes | SELF") with no central-role
--             bypass — confirmed live that even app.role='owner' sees 0
--             rows for a credential it did not mint itself. But
--             SYNC-PROTOCOL §7.4 re-verification is a CROSS-USER SYSTEM
--             READ by construction: when the cloud re-verifies an
--             offline-authorized approval, it must look up the credential
--             minted for the APPROVER (e.g. the supervisor), not whichever
--             user's session happens to be processing the sync batch. The
--             offline-authorization path — the mechanism D-17's entire
--             fraud-control design rests on — could not work in production
--             over the mimi_app + app_user connection without this fix.
--
-- CHOICE MADE, AND WHY (the coordinator asked for a recommendation, not a
-- coin flip): a SECURITY DEFINER lookup function, NOT an app_is_central()
-- arm on the table policy. Reasoning:
--   - offline_credentials holds `pin_verifier` (an argon2id hash of a
--     6-digit PIN — only 1,000,000 possible values; memory-hard hashing
--     slows but does not prevent offline brute-force by anyone who can read
--     the hash) and `binding_secret_enc` (the per-issuance HMAC key,
--     encrypted at rest, but still the exact keying material SYNC-PROTOCOL
--     §7.1's threat model is built to keep away from anyone who doesn't
--     strictly need it). SYNC-PROTOCOL §7.1 explicitly assumes an adversary
--     who controls a device; minimising which server-side contexts can
--     even READ this material (not just who is authorized to act on it)
--     is exactly the "assume breach" posture that threat model calls for.
--   - Re-verification (SYNC-PROTOCOL §7.4 checks 1-8) never needs
--     `pin_verifier` at all — PIN verification happens locally on the
--     device against the cached credential; the cloud never re-derives or
--     re-checks a PIN value at apply time. An app_is_central() arm would
--     hand every owner/manager/finance/hr_admin session (including a
--     merely-compromised one, not just a malicious insider) blanket read
--     access to every PIN verifier and every binding secret in the
--     database, for a capability that only ever needs 12 of the table's 14
--     columns and only for one row at a time. That is a strictly larger
--     blast radius for zero additional functionality.
--   - This mirrors the technique already used to fix the surat_jalan/
--     sj_drops RLS recursion (201): a narrow, auditable SECURITY DEFINER
--     function instead of a broader policy change.
--
-- WHAT IS READABLE BY WHOM AFTER THIS MIGRATION (stated plainly, since this
-- is a security-sensitive widening either way):
--   - The BASE TABLE's RLS is UNCHANGED: still SELF-only, no
--     app_is_central() arm added. A central role (owner/manager/finance/
--     hr_admin) querying `offline_credentials` directly still sees only
--     rows where user_id = their own app.user_id — confirmed live below.
--   - The NEW function `app_offline_credential_for_verification(credential_id)`
--     is SECURITY DEFINER (bypasses RLS internally) and returns a NARROWED
--     row — every column needed by SYNC-PROTOCOL §7.4 checks 1-8
--     (credential_id, user_id, device_id, role_key, location_ids, scopes,
--     binding_secret_enc, selfie_required_above, volume_cap, use_count,
--     minted_at, expires_at, revoked_at) for ANY credential_id, regardless
--     of the calling session's app.role or app.user_id. It deliberately
--     EXCLUDES pin_verifier — no caller, through this function, can ever
--     read a PIN verifier belonging to a user other than themselves (the
--     base table's SELF policy is still the only path to that column, for
--     everyone including central roles).
--   - EXECUTE is granted only to app_user (the sole runtime role) — the
--     same access boundary as everything else in this schema. This
--     function is intended to be called exclusively from the kernel sync/
--     offline-authorization re-verification path (M23/W2-D); it is not
--     bound to a specific permission key because the re-verification
--     service is not acting as any one human role — it is acting as the
--     system, which is precisely the situation this function exists for.
-- Created at: 2026-08-19

BEGIN;

CREATE FUNCTION app_offline_credential_for_verification(p_credential_id UUID)
RETURNS TABLE (
  credential_id UUID,
  user_id UUID,
  device_id UUID,
  role_key VARCHAR(30),
  location_ids UUID[],
  scopes JSONB,
  binding_secret_enc BYTEA,
  selfie_required_above NUMERIC(18,2),
  volume_cap INTEGER,
  use_count INTEGER,
  minted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    oc.credential_id, oc.user_id, oc.device_id, oc.role_key, oc.location_ids, oc.scopes,
    oc.binding_secret_enc, oc.selfie_required_above, oc.volume_cap, oc.use_count,
    oc.minted_at, oc.expires_at, oc.revoked_at
  FROM offline_credentials oc
  WHERE oc.credential_id = p_credential_id;
$$;

REVOKE ALL ON FUNCTION app_offline_credential_for_verification(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_offline_credential_for_verification(UUID) TO app_user;

COMMIT;
