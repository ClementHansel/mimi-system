-- Migration: 256_brand_and_voucher_settings
-- Block: 250-259 (document designers + vouchers)
-- Description: seeds the two new `settings` rows the document/voucher work
--              introduces — `brand.identity` and `pos.voucher_offline`.
-- Created at: 2026-08-27
--
-- Both keys are already declared in `packages/shared/src/constants.ts`'s
-- `SETTINGS_KEY_LIST` and both are structurally validated by
-- `apps/backend/src/modules/settings/settings-value-validator.ts`. This
-- migration only supplies the DEFAULT ROW, because `SettingsService.putOne`
-- is an UPDATE, not an upsert: a key with no row 404s on write with "Unknown
-- settings key", which would look exactly like a missing key rather than a
-- missing seed. Every other key in `SETTINGS_KEY_LIST` is seeded the same way
-- (migration 007); the one deliberate exception is `approval.mode`, whose
-- repository self-seeds via ON CONFLICT for reasons its own comment records.
--
-- `brand.identity` — WHY THE LOGO IS NOT IN IT
-- -------------------------------------------
-- `company.profile.logoAttachmentId` already exists (seeded in 007) and
-- already IS the company's logo. A second `logoAttachmentId` here would be
-- two places to set one thing, and the first screen to read the wrong one
-- prints a blank letterhead. So this key carries only what had nowhere to
-- live: the favicon and the four document colours. The Brand panel in Admin
-- writes BOTH keys, which is why an owner never has to know this. The full
-- reasoning is in `packages/shared/src/brand.ts`'s header.
--
-- The values below are `DEFAULT_BRAND_IDENTITY` from that file, transcribed:
-- primary = brand-600 (the `themeColor` the root layout already declares),
-- accent = brand-500, ink = stone-900, muted = stone-500 — so a fresh install
-- prints in the same terracotta the app is already painted in rather than in
-- a placeholder blue.
--
-- YES, THIS IS A SECOND COPY of a constant that also lives in TypeScript, and
-- that is the opposite of the call migration 253 makes about document
-- layouts. The difference is what happens when the two drift. A template's
-- default is ~90 element objects that the code falls back to on a MISSING
-- row, so duplicating it in SQL would create a second layout that silently
-- wins on fresh installs. This is four hex strings that the code falls back
-- to only if the row is absent entirely; if a later release changes the
-- shipped palette, existing installs keep the colours their documents already
-- print in (correct — a palette change should not silently repaint an
-- owner's stationery), and new installs get the new ones. Drift here is the
-- intended behaviour, not a bug.
--
-- `pos.voucher_offline` — WHY THE DEFAULT IS 'reject'
-- --------------------------------------------------
-- An offline till has no way to know a coupon was not already spent at the
-- next outlet an hour ago. `'reject'` refuses the coupon during a WAN cut;
-- the sale still completes, the customer just does not get the discount at
-- that moment. `'accept'` trades that for not turning a customer away, and
-- the sale carries the code so the server redeems it on sync — a double-spend
-- then lands as a reconciliation exception rather than as silent lost margin.
--
-- Defaulting to the safe answer is deliberate: an owner who wants the other
-- trade has to choose it, and the screen that offers the choice is where the
-- trade-off gets explained. See `packages/shared/src/voucher/index.ts`'s
-- `VoucherOfflinePolicy` and `voucher-redemption.service.ts`'s offline path.
--
-- Stored as a JSON STRING (`'"reject"'`), not a bare token: `settings.value`
-- is JSONB and the validator declares this key as `{ kind: 'string' }`, the
-- same shape `pos.cash_variance_propose_above` and
-- `offline.selfie_required_above` already use.

BEGIN;

INSERT INTO settings (key, value, description) VALUES
  ('brand.identity',
   '{"faviconAttachmentId":null,"primaryColor":"#a8481a","accentColor":"#c85f26","inkColor":"#1c1917","mutedColor":"#78716c"}',
   'Brand favicon + the four colours every printed document resolves its brand.* tokens against (see packages/shared/src/brand.ts)'),
  ('pos.voucher_offline',
   '"reject"',
   'Whether an offline till may accept a voucher it cannot verify: reject (safe default) or accept (takes it on faith; a double-spend surfaces as a sync exception)')
ON CONFLICT (key) DO NOTHING;

COMMIT;
