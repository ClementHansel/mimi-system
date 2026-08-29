-- Migration: 262_frlog03_location_delivery_cadence
-- Block: 2xx (fixes / gaps)
-- Description: FR-LOG-03 — per-outlet delivery cadence.
--
--              The PRD asks the system to "support flexible delivery
--              frequency: daily, 2-3x weekly, or weekly depending on distance
--              and sales". Nothing in the schema carried that: a Surat Jalan
--              has a `planned_date`, which records what WAS shipped, and no
--              column anywhere said what an outlet is SUPPOSED to receive.
--
--              Owner decision 2026-08-29: this is a per-outlet configuration
--              the logistics team plans against, NOT a scheduler that
--              generates shipments. So it is one column, read by humans on the
--              planning screen — deliberately not a rules engine that proposes
--              draft SJs, which would need its own answers for what happens
--              when a proposal is ignored or edited.
--
--              NULLABLE, and that is the interesting part. A null means "no
--              cadence agreed yet", which is genuinely different from
--              'weekly': an outlet nobody has decided about should look
--              undecided on the planning screen rather than silently adopt the
--              rarest schedule. Defaulting this column would have quietly
--              asserted a delivery agreement for every existing outlet.
-- Created at: 2026-08-29

BEGIN;

ALTER TABLE locations
  ADD COLUMN delivery_cadence VARCHAR(20)
    CHECK (delivery_cadence IN ('daily', 'twice_weekly', 'thrice_weekly', 'weekly'));

COMMENT ON COLUMN locations.delivery_cadence IS
  'FR-LOG-03 — how often this outlet is meant to be replenished. Planning '
  'input for the logistics team, not a scheduler: nothing generates shipments '
  'from it. NULL = not yet agreed, which is distinct from ''weekly''. '
  'Meaningless on a warehouse, which ships rather than receives.';

-- Partial index: the planning screen asks "which outlets are on each cadence",
-- and the rows without one are the other half of that question ("who still
-- needs deciding"). Both are small result sets against a table of tens of
-- rows, so this is about intent as much as speed.
CREATE INDEX idx_locations_delivery_cadence
  ON locations(delivery_cadence)
  WHERE delivery_cadence IS NOT NULL;

COMMIT;
