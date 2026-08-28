-- =============================================================================
-- W7 follow-up — "signed by all" (owner ask, 2026-08-27): "the contract for
-- employee need to be able to be made, signed by all, and will be linked to
-- each employee". Migration 230 gave contracts a shape, a number, and a
-- `signed_at DATE` — but `signed_at` is one date on the whole row. It cannot
-- say WHO signed, whether the employee's side is done but the company's
-- isn't, or when each party actually signed. That is a real gap: "signed by
-- all" is a claim about MULTIPLE PARTIES, and one column cannot carry it.
--
-- THIS TABLE, NOT A WIDER `employment_contracts`. A signature is a fact about
-- one party's act, not an attribute of the contract row — the same reason
-- `contract_signatures` gets its own table instead of `signed_by_1`/
-- `signed_by_2` columns: an unknown number of company co-signers (owner,
-- HR — "signer(s)", plural) cannot be modelled as a fixed set of columns
-- without either wasting most of them (one signer) or running out (three).
--
-- PARTIES: the employee, by `employees.id` (the contract already has exactly
-- one), and the company side, by `users.id` — modelled the way the owner ask
-- specified it ("company signer(s) — model the company side by users.id, the
-- employee side by employees.id"). A `users` row is a real authenticated
-- identity with a name and a role; that is who actually signs on the
-- company's behalf, never the abstract "company" as an entity.
--
-- `signed_at` HERE IS TIMESTAMPTZ, NOT DATE. 230's `signed_at DATE` records
-- when the PAPER was dated; this records when a specific person's signing
-- ACT happened, which is a point in time, not a business date — the same
-- distinction `created_at`/`updated_at` draw everywhere else in this schema.
--
-- `method` — "how it was signed" — exists because a wet-ink scan and a
-- witnessed in-person signature and a digital signature carry different
-- evidentiary weight, and a report that cannot tell them apart is not
-- trustworthy. `document_attachment_id` (230) is NOT replaced by any of
-- this: a scanned wet-ink contract is still a valid record on its own: the
-- signature rows record WHO and WHEN, they do not stand in for the scan.
--
-- WHY A TRIGGER, NOT ONLY A SERVICE CHECK (the same reasoning 230 gives for
-- its own CHECKs — "an expiry report is only as trustworthy as the
-- constraint under it"): `ContractsService` already validates the type/term
-- rule AND relies on 230's CHECK as the guarantee beneath it. "Cannot go
-- active unsigned" deserves the identical treatment — a future code path
-- (a fixed-up import, a hotfix, a direct `UPDATE`) must not be able to flip
-- `status = 'active'` on an unsigned contract just because it bypassed
-- `ContractsService.update`. A CHECK constraint cannot express "a matching
-- row exists in another table", so this has to be a trigger — the DB-level
-- equivalent of a CHECK for a cross-table invariant.
--
-- CONSEQUENCE WORTH STATING EXPLICITLY: because the trigger fires on INSERT
-- too, and a brand-new contract's id cannot already have signature rows
-- (nothing can reference a row that does not exist yet), NO CONTRACT CAN BE
-- CREATED PRE-ACTIVE ANY MORE — every contract is born `draft` (see the
-- column default change below and `ContractsService.create`'s matching
-- default), gets signed by both required parties through the new
-- `POST /hr/contracts/:id/sign` endpoint, and only THEN can be moved to
-- `active`. That is the entire point of this migration: activation is now a
-- consequence of signing, not a status a caller can simply assert.
-- =============================================================================

BEGIN;

CREATE TABLE contract_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  party_type VARCHAR(10) NOT NULL CHECK (party_type IN ('employee', 'company')),
  -- Exactly one of these is set, matching party_type — enforced below, not by
  -- hope: a row that claims to be the employee's signature but points at a
  -- `users.id` (or vice versa) is not a signature, it is a bug.
  employee_id UUID REFERENCES employees(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method VARCHAR(20) NOT NULL CHECK (method IN ('wet_ink_scan', 'digital', 'in_person_witnessed')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT contract_signature_party_matches_column CHECK (
    (party_type = 'employee' AND employee_id IS NOT NULL AND user_id IS NULL)
    OR (party_type = 'company' AND user_id IS NOT NULL AND employee_id IS NULL)
  )
);

-- "One signature row per party per contract." The employee side of a
-- contract is a single, fixed party (the contract has exactly one
-- `employee_id`), so a partial unique index on `contract_id` alone is
-- correct for that half. The company side can have more than one signer
-- (owner ask: "signer(s)"), so its uniqueness is per (contract, signer) — one
-- particular person cannot sign the same contract twice, but a second,
-- different company officer co-signing is a different party and allowed.
CREATE UNIQUE INDEX ux_contract_signatures_employee
  ON contract_signatures (contract_id) WHERE party_type = 'employee';
CREATE UNIQUE INDEX ux_contract_signatures_company
  ON contract_signatures (contract_id, user_id) WHERE party_type = 'company';

CREATE INDEX idx_contract_signatures_contract ON contract_signatures (contract_id);

-- ---------------------------------------------------------------------------
-- Activation gate. A contract may only carry `status = 'active'` once BOTH
-- required parties — the employee, and at least one company signer — have a
-- row here. See the file header for why this is a trigger and not (only) a
-- service-level check, and why it means a contract can never be INSERTed
-- already active.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_contract_signed_before_active()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM contract_signatures
       WHERE contract_id = NEW.id AND party_type = 'employee'
    ) THEN
      RAISE EXCEPTION 'employment_contracts %: cannot go active — the employee has not signed', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM contract_signatures
       WHERE contract_id = NEW.id AND party_type = 'company'
    ) THEN
      RAISE EXCEPTION 'employment_contracts %: cannot go active — no company signer yet', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contracts_require_signatures_before_active
  BEFORE INSERT OR UPDATE OF status ON employment_contracts
  FOR EACH ROW EXECUTE FUNCTION check_contract_signed_before_active();

-- A contract is born unsigned, so it can no longer be born `active` (the
-- trigger above would refuse it anyway) — `draft` is the honest default.
-- `ContractsService.create`'s own default is updated to match in the same
-- round; this is the DB-level half of that fact.
ALTER TABLE employment_contracts ALTER COLUMN status SET DEFAULT 'draft';

-- ---------------------------------------------------------------------------
-- RLS — mirrors `employment_contracts_scope` (230) exactly and deliberately:
-- a signature is exactly as sensitive as the contract it belongs to (WHO
-- signed a salary agreement is not less sensitive than the agreement
-- itself), and any looser rule here would be a side door around 230's own
-- policy. An employee sees their OWN contract's signatures (both parties'
-- rows — they need to see the company side has signed too, to know their
-- contract is fully executed) via the same `hr.contract.read.own` path;
-- central HR roles and a location supervisor see what 230 already lets them
-- see. Writes are office-only, same as 230: there is no self-sign path here
-- either — see `ContractsController`'s `sign` endpoint doc comment for why
-- (recording a signature, even the employee's own, is a controlled act that
-- only `hr.contract.manage` may perform, to keep the signature record itself
-- resistant to the same kind of forgery §3 of the ticket calls out for CSV
-- import).
-- ---------------------------------------------------------------------------
ALTER TABLE contract_signatures ENABLE ROW LEVEL SECURITY;

CREATE POLICY contract_signatures_scope ON contract_signatures FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin')
    OR EXISTS (
      SELECT 1 FROM employment_contracts c
        JOIN employees e ON e.id = c.employee_id
       WHERE c.id = contract_signatures.contract_id
         AND (
           app_is_self(e.user_id)
           OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(e.location_id))
         )
    )
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON contract_signatures TO mimi_app;

COMMIT;
