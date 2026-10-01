-- Migration: 270_grabfood_channel
-- Block: late-stage POS amendment (2xx per-agent fix block, CONTRACTS §8.1)
-- Description: GrabFood becomes the third online sales channel next to GoFood
--              and ShopeeFood. The client's real outlets sell through all
--              three; GrabFood revenue had nowhere to go because every place
--              that enumerates the platforms stopped at two.
-- Created at: 2026-10-01
--
-- WHAT THIS WIDENS
-- --------------------------------------------------------------------------
--   1. `sales.channel` CHECK (249)        walk_in | gofood | shopeefood
--                                         -> + grabfood
--   2. `online_orders.platform` CHECK (053) gofood | shopeefood
--                                         -> + grabfood. `online_orders` is
--      dormant as a revenue path (249), but its create endpoint and the sync
--      projector's `online_order.recorded` handler both validate against the
--      shared `OnlinePlatform` enum, which now includes 'grabfood'; leaving
--      this CHECK at two values would turn a request the DTO accepts into a
--      raw 23514 at INSERT time. The two enums must never disagree.
--   3. `products.price_grabfood NUMERIC(18,2) NULL` — same shape, same
--      NULL-means-"fall back to `price`" rule as `price_gofood` /
--      `price_shopeefood` (249). No CHECK of its own, for the same reason 249
--      gives: the decimal-string wire value is validated at the DTO layer.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
-- --------------------------------------------------------------------------
-- `mv_sales_daily` (251) derives `platform` as `NULLIF(channel, 'walk_in')`
-- and never lists the platforms, so a 'grabfood' sale lands in its own
-- `platform = 'grabfood'` bucket and every `platform IS NOT NULL` ("is this
-- online revenue") filter downstream picks it up with no rebuild. Rebuilding
-- a materialized view over ~220k sales rows for nothing would be pure risk.
--
-- GL posting needs no change either: `outlet_sales` (093) is posted by the
-- daily aggregator from `sale_payments.method` (cash/qris/bank_transfer) and
-- never reads `sales.channel`, so a GrabFood sale posts exactly the legs a
-- GoFood or ShopeeFood sale does — Dr 1000/1031/1032 by payment method,
-- Cr 4000. See `daily-posting.service.ts`.
--
-- WHY THE CONSTRAINTS ARE FOUND BY DEFINITION, NOT BY NAME
-- --------------------------------------------------------------------------
-- Both CHECKs were declared inline and unnamed, so Postgres auto-named them
-- (`sales_channel_check`, `online_orders_platform_check`). That name is an
-- implementation detail of whichever Postgres built the database; looking the
-- constraint up by the column it guards and recreating it under the same name
-- keeps this migration correct on a database where the auto-name differed,
-- instead of failing on a hard-coded DROP.

BEGIN;

DO $$
DECLARE
  con_name text;
BEGIN
  -- sales.channel
  FOR con_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'sales'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE sales DROP CONSTRAINT %I', con_name);
  END LOOP;

  -- online_orders.platform
  FOR con_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'online_orders'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%platform%'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%platform_fee%'
  LOOP
    EXECUTE format('ALTER TABLE online_orders DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE sales
  ADD CONSTRAINT sales_channel_check
    CHECK (channel IN ('walk_in', 'gofood', 'shopeefood', 'grabfood'));

ALTER TABLE online_orders
  ADD CONSTRAINT online_orders_platform_check
    CHECK (platform IN ('gofood', 'shopeefood', 'grabfood'));

ALTER TABLE products
  ADD COLUMN price_grabfood NUMERIC(18,2);

COMMENT ON COLUMN products.price_grabfood IS
  'GrabFood price, IDR (absorbs platform commission — no separate fee line, same owner decision as price_gofood, 2026-08-27). NULL = falls back to price.';

COMMENT ON COLUMN sales.channel IS
  'Which counter this was rung up under. walk_in is the till default; gofood/shopeefood/grabfood is the cashier manually selecting the platform for an order phoned/app-relayed in — see PosSaleService. Replaces online_orders as the revenue+stock record for platform orders going forward (online_orders is left dormant, not dropped: see pos-online-order.service.ts header).';

COMMENT ON MATERIALIZED VIEW mv_sales_daily IS
  'FR-DASH-01/02/03 daily rollup, grain (location_id, sales_date, platform). platform NULL = walk-in; platform IN (gofood, shopeefood, grabfood) = online, sourced from sales.channel from migration 251 forward (NULLIF(channel,''walk_in'')) and from the now-dormant online_orders for everything before it (migration 249 retired that write path but left the table readable) — the two are UNIONed and re-aggregated so the online series is continuous across the cutover, never a source-swap cliff.';

-- ── Verification: both CHECKs must now accept 'grabfood' and still refuse a
-- value that is not a platform, and the new price column must exist. Reading
-- the constraint definitions (rather than inserting fabricated rows) keeps
-- this safe on a database full of real sales.
-- ============================================================================
DO $$
DECLARE
  sales_def text;
  online_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO sales_def
    FROM pg_constraint WHERE conrelid = 'sales'::regclass AND conname = 'sales_channel_check';
  SELECT pg_get_constraintdef(oid) INTO online_def
    FROM pg_constraint WHERE conrelid = 'online_orders'::regclass AND conname = 'online_orders_platform_check';

  IF sales_def IS NULL OR sales_def NOT LIKE '%grabfood%' OR sales_def NOT LIKE '%walk_in%' THEN
    RAISE EXCEPTION 'sales.channel CHECK was not widened to include grabfood (got: %)', sales_def;
  END IF;
  IF online_def IS NULL OR online_def NOT LIKE '%grabfood%' THEN
    RAISE EXCEPTION 'online_orders.platform CHECK was not widened to include grabfood (got: %)', online_def;
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'sales'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%channel%') <> 1 THEN
    RAISE EXCEPTION 'sales should carry exactly one channel CHECK after 270';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'price_grabfood'
       AND is_nullable = 'YES' AND numeric_precision = 18 AND numeric_scale = 2
  ) THEN
    RAISE EXCEPTION 'products.price_grabfood is missing or has the wrong shape';
  END IF;
END $$;

COMMIT;
