-- Migration: 254_vouchers
-- Block: 250-259 (document designers + vouchers)
-- Description: voucher_batches + vouchers + voucher_redemptions — printed
--              discount coupons, minted in batches and spent once at a till.
-- Created at: 2026-08-27
--
-- THE ONE THING THIS SCHEMA EXISTS TO GUARANTEE
-- ---------------------------------------------
-- A coupon is money. The single failure that actually costs the owner is a
-- DOUBLE SPEND: the same printed code accepted twice, at two tills, in the
-- same minute. `voucher_redemptions.voucher_id` is UNIQUE, and that
-- constraint — not application code — is what makes it impossible.
--
-- Read that literally. `VoucherService.redeem` also checks
-- `vouchers.status = 'active'` first, and that check is a courtesy: it gives
-- the cashier a clean "already used" message in the common case. It is NOT
-- the guard. Two concurrent transactions can both SELECT `status = 'active'`
-- before either commits — that is the definition of a read/write race, and no
-- amount of ordering in TypeScript closes it. What closes it is that the
-- SECOND `INSERT INTO voucher_redemptions` blocks on the unique index and
-- then fails with SQLSTATE 23505, whichever transaction gets there second.
-- The service catches exactly that code and returns `ERR_VOUCHER_NOT_ACTIVE`,
-- so the losing till shows the same message it would have shown if it had
-- simply been slower — see `voucher.service.ts`'s `UNIQUE_VIOLATION` handler.
--
-- Consequences of putting the guard here rather than in code, all deliberate:
--   * No advisory lock, no `SELECT ... FOR UPDATE` on the voucher row, no
--     serializable isolation. The index is the serialization point.
--   * It holds across processes, across backend replicas, and across a
--     cloud/edge split. An application mutex would not.
--   * It holds for the OFFLINE path too. Two tills that were both offline can
--     both take the same coupon; when they sync, the first projected sale
--     redeems it and the second hits 23505 and lands as a reconciliation
--     exception (`kernel/sync/reconciliation.service.ts`) rather than as
--     silently lost margin. That is the whole reason `offline_accepted` is a
--     column: it is the flag that says "this one was taken on faith".
--
-- WHY A REDEMPTION IS ITS OWN TABLE, NOT COLUMNS ON `vouchers`
-- ------------------------------------------------------------
-- `vouchers.redeemed_sale_id` + `vouchers.redeemed_at` on the voucher row
-- would have worked for the happy path and lost the race guard: an UPDATE
-- cannot be UNIQUE-constrained on "was previously NULL". A separate row with
-- a UNIQUE FK turns "spend it" into an INSERT, and an INSERT is the only shape
-- a unique index can arbitrate. `vouchers.status` is then a DERIVED
-- convenience — the thing the till's lookup reads without a join — and the
-- redemption row is the fact.
--
-- WHY BATCHES ARE NETWORK-WIDE AND CARRY NO RLS
-- ---------------------------------------------
-- A coupon printed by head office is spent at whichever outlet the customer
-- walks into; `voucher_batches.location_ids` (nullable = every outlet) is a
-- BUSINESS rule the shared `checkVoucher()` enforces, not a visibility rule.
-- If `voucher_batches`/`vouchers` were location-scoped, a till could not even
-- LOOK UP a code that its own outlet is entitled to accept whenever the batch
-- was authored elsewhere — the lookup would return "not found" for a
-- perfectly valid coupon and the cashier would be arguing with a customer
-- holding real paper. So both tables sit in CONTRACTS.md §1.14's "NONE"
-- group: API-gated by `PermissionsGuard` (`voucher.read` / `.manage` /
-- `.issue` / `.redeem`) only. Note what that does and does not expose — a
-- kasir holds `voucher.redeem` and can therefore ask "what is code X worth on
-- this basket", which is exactly the job; `voucher.read` (listing batches and
-- their unspent codes, i.e. a list of live coupon numbers) stops at
-- owner/manager/finance/supervisor/kasir per the matrix, and `voucher.issue`
-- — minting new money — stops at owner/manager/finance.
--
-- `voucher_redemptions` IS DIFFERENT AND IS LOCATION-SCOPED
-- --------------------------------------------------------
-- A redemption is not a coupon, it is a SALE EVENT: it happened at one
-- outlet, on one sale, by one cashier, for a rupiah amount that shows up in
-- that outlet's discounts. That is the same thing `sales` is, so it gets the
-- same policy `sales` has had since migration 055 —
-- `app_has_location(location_id)`, FORCE ROW LEVEL SECURITY — rather than a
-- second convention for the same kind of row. A supervisor who cannot read
-- another outlet's sales must not be able to read another outlet's discounts
-- either; that would be the same leak by a different column.
--
-- KNOW WHAT THAT COSTS, BECAUSE IT IS SUBTLE. Under this policy a till at
-- outlet A cannot SEE the redemption row written at outlet B. It therefore
-- cannot answer "has this coupon been spent" by querying this table. It does
-- not have to, and must not try: the visible signal is `vouchers.status`,
-- which is network-wide because `vouchers` carries no RLS, and the
-- authoritative signal is the unique index, which is enforced BELOW row
-- security (a unique index arbitrates rows the inserting session cannot
-- see — that is a property of the index, not of the policy). So the race
-- guard is unaffected by the scoping; only the error message a losing till
-- can construct is. It gets `ERR_VOUCHER_NOT_ACTIVE`, not "redeemed at outlet
-- B at 14:03", and that is the correct amount of cross-outlet disclosure for
-- a cashier.
--
-- Head office is unaffected: `app_is_central()` roles (owner/manager/finance/
-- superadmin — see 001) satisfy `app_has_location()` for every location, so
-- the reconciliation and reporting views over this table see everything.
--
-- MONEY AND PERCENTAGES SHARE ONE COLUMN, DELIBERATELY
-- ----------------------------------------------------
-- `voucher_batches.value` is `NUMERIC(18,2)` and its MEANING depends on
-- `type`: for `fixed` it is a rupiah amount (`'10000.00'` = Rp 10.000 off);
-- for `percentage` it is a percent with two decimals (`'10.00'` = 10%, NOT
-- 0.10). The shared `checkVoucher()` is the only thing that reads it and it
-- switches on `type` first, so the ambiguity never reaches a caller. Two
-- columns (`fixed_amount` + `percent`) with a CHECK that exactly one is
-- non-NULL was the alternative; it was rejected because every consumer would
-- then need a COALESCE and the "exactly one" CHECK is itself the same
-- either/or, spelled longer. What IS worth pinning is the range, so a
-- percentage above 100 cannot be typed in: see `chk_voucher_batch_value`.
-- Scale note: `divideByHundred()` in `packages/shared/src/voucher/index.ts`
-- throws above two fractional digits, which `NUMERIC(18,2)` already
-- guarantees for anything this table produces.

BEGIN;

-- =============================================================================
-- voucher_batches — one print run
-- =============================================================================

CREATE TABLE voucher_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human batch code, e.g. 'PROMO-AGT-26'. UNIQUE because it is what an owner
  -- says out loud ("void the August batch") and what is printed on the card
  -- via the `batch_code` field token. Distinct from `vouchers.code`, which is
  -- the machine-minted single-use number.
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,

  type VARCHAR(20) NOT NULL CHECK (type IN ('fixed', 'percentage')),
  -- Rupiah when type='fixed'; percent-with-two-decimals when
  -- type='percentage'. See the header.
  value NUMERIC(18,2) NOT NULL,

  -- Basket floor before the voucher applies. 0 = no floor. NOT NULL with a
  -- DEFAULT rather than nullable: "no minimum" and "minimum of zero" are the
  -- same rule, and `checkVoucher()` compares against it unconditionally, so a
  -- NULL would only ever be a COALESCE waiting to be forgotten.
  min_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),

  -- Percentage cap. NULL = uncapped. Meaningless for a fixed batch and
  -- constrained to NULL there, so a fixed batch cannot carry a cap that
  -- nothing would ever apply.
  max_discount NUMERIC(18,2) CHECK (max_discount IS NULL OR max_discount > 0),

  -- WITA business dates (D-11), compared as plain ISO strings by
  -- `checkVoucher()`. DATE, not TIMESTAMPTZ: a coupon is valid for a DAY, and
  -- the day it expires must not depend on what hour the till's clock says.
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,

  -- NULL = usable at every outlet. A non-empty array restricts it. Stored as
  -- a plain UUID[] rather than a `voucher_batch_locations` join table because
  -- it is read as a WHOLE, always, by `checkVoucher()` — no query ever asks
  -- "which batches apply at outlet X" in a way that would want an index, and
  -- the array is what the offline device caches verbatim.
  location_ids UUID[],

  -- Owner-authored terms printed on the card (`terms` field token). Free text
  -- in the OWNER's language — this is their copy, not product copy, so the
  -- no-Bahasa-in-the-backend rule (BUILD-PLAN §6.9) does not apply to it.
  terms TEXT,

  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'closed')),

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A window that ends before it starts would make every check return
  -- 'expired' with no way to see why from the batch screen.
  CONSTRAINT chk_voucher_batch_window CHECK (valid_until >= valid_from),

  -- A percentage over 100 would hand money back; a negative value of either
  -- kind would ADD to the bill. `checkVoucher()` clamps the resulting
  -- discount to the subtotal anyway, but clamping a nonsense input produces a
  -- nonsense coupon that prints "-5%" on real card stock. Reject at the door.
  CONSTRAINT chk_voucher_batch_value CHECK (
    value > 0 AND (type <> 'percentage' OR value <= 100)
  ),

  -- `max_discount` caps a PERCENTAGE. On a fixed batch `value` is already the
  -- cap, so a second one could only ever contradict it.
  CONSTRAINT chk_voucher_batch_cap CHECK (
    type = 'percentage' OR max_discount IS NULL
  )
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON voucher_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_voucher_batches_status ON voucher_batches(status, created_at DESC);

-- =============================================================================
-- vouchers — one printed coupon
-- =============================================================================

CREATE TABLE vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT: a batch with issued coupons in customers' wallets must not be
  -- deletable. Closing a batch is `status = 'closed'`; there is no delete.
  batch_id UUID NOT NULL REFERENCES voucher_batches(id) ON DELETE RESTRICT,

  -- `MC-XXXX-XXXX` from `formatVoucherCode()`. UNIQUE ACROSS ALL BATCHES, not
  -- per batch: the till looks a code up by code alone (the customer hands over
  -- paper, not a batch id), so two batches sharing a code would make the
  -- lookup ambiguous at exactly the moment it must not be. The minter retries
  -- on collision against this constraint — see `voucher.service.ts`.
  code VARCHAR(20) UNIQUE NOT NULL,

  -- Derived from `voucher_redemptions` for 'redeemed'; authoritative for
  -- 'void'. Denormalised on purpose: this is the column the till's hot lookup
  -- reads, and it must not need a join to a location-scoped table (see the
  -- header's note on why `voucher_redemptions` is scoped and this is not).
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redeemed', 'void')),

  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when a batch's card sheet is actually printed. Nullable forever: an
  -- owner may issue codes for a digital campaign and never print anything.
  printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE till's lookup: `WHERE code = $1`. Already backed by the UNIQUE
-- constraint's index, so this is not a second index — recorded here only so
-- the next reader does not add one.

-- Batch screens page through "this batch's unspent codes" and show per-status
-- counts; that is the only other access shape.
CREATE INDEX idx_vouchers_batch_status ON vouchers(batch_id, status);

-- =============================================================================
-- voucher_redemptions — the fact that a coupon was spent
-- =============================================================================

CREATE TABLE voucher_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ══ THE SINGLE-USE ENFORCEMENT ══
  -- This UNIQUE is the entire double-spend guard. See this migration's header
  -- for why it is here and not in application code, and for why it survives
  -- concurrency, replicas, and the offline sync path. Do not relax it to
  -- UNIQUE (voucher_id, sale_id) or drop it in favour of a status check.
  voucher_id UUID UNIQUE NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,

  -- Nullable: an offline-accepted redemption can be recorded before its sale
  -- has been projected, and a redemption whose sale is later VOIDED keeps its
  -- row (a voided sale does not un-spend a coupon that left the building —
  -- reversing that is an explicit owner decision, not a cascade).
  sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,

  -- WHERE it happened. This is the RLS scoping column — see the header.
  location_id UUID NOT NULL REFERENCES locations(id),

  -- What the SERVER computed from `checkVoucher()` against the server's own
  -- subtotal, never what the device claimed. `voucher.service.ts` recomputes
  -- unconditionally on both the online and the sync path.
  discount_amount NUMERIC(18,2) NOT NULL CHECK (discount_amount >= 0),

  redeemed_by UUID REFERENCES users(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- TRUE when the till was offline and `pos.voucher_offline = 'accept'` let it
  -- take the coupon on faith. These are the rows worth auditing: they are the
  -- only ones where the "is it still active" question was answered by a stale
  -- device cache instead of by this table's unique index.
  offline_accepted BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_voucher_redemptions_location_date
  ON voucher_redemptions(location_id, redeemed_at DESC);
CREATE INDEX idx_voucher_redemptions_sale ON voucher_redemptions(sale_id);

-- =============================================================================
-- RLS
-- =============================================================================
-- `voucher_batches` and `vouchers`: NONE group (see the header). No policy.
-- `voucher_redemptions`: LOC group, byte-for-byte the shape `sales_loc` has
-- carried since migration 055.

ALTER TABLE voucher_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY voucher_redemptions_loc ON voucher_redemptions FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

COMMENT ON CONSTRAINT voucher_redemptions_voucher_id_key ON voucher_redemptions IS
  'Single-use enforcement. This constraint, not application code, is what makes a double-spend impossible — including two tills racing on the same code. See migration 254''s header.';

GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_batches TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON vouchers TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_redemptions TO app_user;

COMMIT;
