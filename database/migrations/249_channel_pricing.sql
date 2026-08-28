-- Migration: 249_channel_pricing
-- Block: late-stage POS amendment (2xx per-agent fix block, CONTRACTS §8.1)
-- Description: three-tier channel pricing (owner decision, 2026-08-27) — a
--              product now carries an optional GoFood/ShopeeFood price on top
--              of its walk-in `price`, and a sale records which channel it
--              was rung up under. This is the schema half of retiring the
--              separate online-order flow: GoFood/ShopeeFood orders are now
--              rung up as an ordinary POS sale with `channel` set, in the
--              SAME till interface as walk-in — one record posts revenue
--              once and, unlike `online_orders` (migration 053, which has no
--              line items), actually explodes the recipe and consumes stock.
-- Created at: 2026-08-27
--
-- WHY TWO NULLABLE COLUMNS ON `products`, NOT A `product_channel_prices` TABLE
-- --------------------------------------------------------------------------
-- `products.price` stays the single source of truth for the walk-in price —
-- no backfill, no dual-truth risk between a "default" row and an override
-- table. Nullable-with-fallback (application layer: `priceGofood ?? price`)
-- means an unset channel price can never silently be read as zero: a product
-- row either explicitly costs more on that platform, or it inherits `price`
-- outright. Same CHECK/precision discipline as `price` itself (migration
-- 012) — NUMERIC(18,2), IDR, and (like `price`) no CHECK constraint of its
-- own; validity of the decimal-string wire value is enforced at the DTO
-- layer (`IsMoneyString`/`MONEY_RE`), same as every other Money field.
--
-- WHY `channel` LIVES ON `sales`, NOT `sale_lines`
-- --------------------------------------------------------------------------
-- A single cart is one till transaction rung up under one platform choice —
-- the cart model has no per-line channel, and mixing a walk-in item into a
-- GoFood cart was never a workflow the owner asked for. `channel` therefore
-- lives once, on the sale header, same grain as `status`/`discount`.
--
-- `DEFAULT 'walk_in'` IS THE CORRECT BACKFILL, NOT JUST A SAFE ONE
-- --------------------------------------------------------------------------
-- Production holds 220,180 `sales` rows and 474,993 `sale_lines` rows — this
-- ALTER TABLE must not rewrite what a single existing row means. Every
-- historical `sales` row genuinely WAS a walk-in till transaction: GoFood/
-- ShopeeFood previously posted through `online_orders` (migration 053), never
-- through `sales`. A fixed-literal DEFAULT needs no table rewrite on PG11+
-- (metadata-only), and even if it did, `'walk_in'` is exactly what every
-- existing row's channel actually was — not a placeholder standing in for
-- "unknown".

BEGIN;

ALTER TABLE products
  ADD COLUMN price_gofood NUMERIC(18,2),
  ADD COLUMN price_shopeefood NUMERIC(18,2);

COMMENT ON COLUMN products.price_gofood IS
  'GoFood price, IDR (absorbs platform commission — no separate fee line, owner decision 2026-08-27). NULL = falls back to price.';
COMMENT ON COLUMN products.price_shopeefood IS
  'ShopeeFood price, IDR (absorbs platform commission — no separate fee line, owner decision 2026-08-27). NULL = falls back to price.';

ALTER TABLE sales
  ADD COLUMN channel VARCHAR(20) NOT NULL DEFAULT 'walk_in'
    CHECK (channel IN ('walk_in', 'gofood', 'shopeefood'));

COMMENT ON COLUMN sales.channel IS
  'Which counter this was rung up under. walk_in is the till default; gofood/shopeefood is the cashier manually selecting the platform for an order phoned/app-relayed in — see PosSaleService. Replaces online_orders as the revenue+stock record for platform orders going forward (online_orders is left dormant, not dropped: see pos-online-order.service.ts header).';

COMMIT;
