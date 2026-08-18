-- Migration: 221_w5_01_delivery_route_instructions_and_tracking
-- Block: 030-039 lineage (replenishment + Surat Jalan logistics, D-14).
-- Description: the two schema gaps behind the dispatcher/driver route feature —
--              per-drop delivery instructions authored by gudang, and live
--              position tracking for a truck in transit.
-- Created at: 2026-08-18
--
-- CONTEXT. D-14 already models a truck's trip properly: `surat_jalan` carries
-- driver + vehicle + planned date, and `sj_drops` carries the ordered stops
-- (`drop_seq`, UNIQUE per `sj_id`) with a full per-stop lifecycle. `locations`
-- already stores `address`, `latitude`, `longitude` and `geofence_radius_m`,
-- populated for all 21 sites. Two things were missing, and both are added here.
--
-- 1. `sj_drops.delivery_instructions`
--    Gudang plans the route; the driver executes it. The stop ORDER was already
--    expressible (`drop_seq`), but there was nowhere to put the human part of a
--    delivery brief — "masuk lewat gang samping", "telepon Pak Andi sebelum
--    sampai", which unloading bay. Without it, dispatchers put that in
--    `surat_jalan.notes`, which is trip-wide: every driver instruction for
--    every stop lands in one blob that the driver has to re-read at each stop
--    and mentally filter. This column is deliberately per-DROP and free text —
--    it is guidance for a human, not a machine-parsed routing directive.
--
--    NOTE it is distinct from the existing `discrepancy_notes`/`failure_reason`
--    on the same table: those are written by the DRIVER after the fact, this is
--    written by GUDANG before dispatch. Same table, opposite direction of
--    authorship, so they must not be conflated into one field.
--
-- 2. `sj_positions`
--    New table. There was no location history of any kind — `device_heartbeats`
--    tracks device health, not geography, and nothing else stored a coordinate
--    against a trip. Live tracking needs an append-only breadcrumb trail.
--
--    Shape notes:
--      * `recorded_at` (when the DEVICE took the fix) is separate from
--        `received_at` (when the cloud accepted it). The driver PWA is
--        offline-first and will flush a queued backlog on reconnect, so these
--        two differ by minutes or hours on a bad signal day. Collapsing them
--        into one column would make an offline stretch indistinguishable from
--        a truck that genuinely stood still, which is exactly the question a
--        dispatcher asks when a delivery is late.
--      * `client_id` is NOT NULL UNIQUE — the idempotency key for that flush.
--        A driver's phone re-sending a batch it was unsure landed must not
--        double-record the trail. Same mechanism `sj_drops`/`sales` already use.
--      * Bounds CHECKs on lat/long/heading reject a garbled fix at the door
--        rather than letting it render as a truck in the Atlantic.
--      * No `location_id`: a position is by definition BETWEEN locations.
--        Scope is derived from the parent `surat_jalan` (see the policy).
--
--    RETENTION — DELIBERATE, AND A STANDING PRIVACY SURFACE. Positions are kept
--    INDEFINITELY by owner's decision (2026-08-18), for delivery-dispute and
--    audit history. This migration therefore installs NO purge job and NO
--    partitioning. Two consequences the next person should know before they are
--    surprised by them:
--      (a) This table grows without bound and is the fastest-growing table in
--          the schema — one row per truck per ping. At a 60s cadence, one truck
--          on an 8-hour route is ~480 rows/day; twenty trucks is ~3.5M rows a
--          year. The `(sj_id, recorded_at DESC)` index keeps the live query
--          flat regardless, but plan for the disk.
--      (b) It is employee location history held forever. If that policy is ever
--          revisited, the purge is a one-liner against `recorded_at` — the
--          schema is deliberately shaped so retention can be added later
--          WITHOUT a data migration. Collection is already narrow: the driver
--          app only reports while an SJ is `in_transit`, never between trips.
--
-- RLS. `sj_positions_scope` mirrors `sj_drops_scope` as last written by 214,
-- for the same reasons and with the same two arms:
--   * anyone holding one of the trip's locations (origin warehouse or any drop
--     destination), resolved through the SECURITY DEFINER `app_sj_locations()`
--     (201) so this policy cannot re-enter `sj_drops`'s own policy and recreate
--     the recursion 201 fixed;
--   * the driver the SJ is assigned to, matched on `drivers.user_id`, so a
--     driver can write their own breadcrumbs and read back their own trail but
--     never another truck's.
-- WITH CHECK repeats USING rather than being widened: a driver must not be able
-- to insert a position onto someone else's Surat Jalan, which is precisely the
-- asymmetry 216 had to go back and fix on `surat_jalan`.

BEGIN;

-- ── 1. Per-drop delivery instructions (authored by gudang, read by driver) ──
ALTER TABLE sj_drops ADD COLUMN IF NOT EXISTS delivery_instructions TEXT;

COMMENT ON COLUMN sj_drops.delivery_instructions IS
  'Free-text delivery brief for THIS stop, written by gudang before dispatch '
  '(access notes, who to call, unloading bay). Distinct from discrepancy_notes/'
  'failure_reason, which the driver writes after the fact.';

-- ── 2. Live position breadcrumbs for a truck in transit ────────────────────
CREATE TABLE IF NOT EXISTS sj_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id),          -- denormalised for fleet queries
  latitude NUMERIC(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m NUMERIC(8,2) CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  speed_kph NUMERIC(6,2) CHECK (speed_kph IS NULL OR speed_kph >= 0),
  heading_deg NUMERIC(5,2) CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  recorded_at TIMESTAMPTZ NOT NULL,               -- when the DEVICE took the fix
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- when the cloud accepted it
  client_id UUID NOT NULL UNIQUE,                 -- offline-flush idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sj_positions IS
  'Append-only GPS breadcrumb trail for a Surat Jalan in transit. Written only '
  'while the trip is in progress; retained indefinitely by owner decision '
  '(2026-08-18) — see migration 221 header before adding a purge.';

-- The live view ("where is truck X now") and the trail replay ("where did it go")
-- are both (sj_id, time-ordered), so one index serves both and stays flat as the
-- table grows without bound.
CREATE INDEX IF NOT EXISTS idx_sj_positions_sj_recorded
  ON sj_positions (sj_id, recorded_at DESC);

-- Fleet-wide "latest ping per driver" for the dispatcher's live board.
CREATE INDEX IF NOT EXISTS idx_sj_positions_driver_recorded
  ON sj_positions (driver_id, recorded_at DESC);

ALTER TABLE sj_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sj_positions_scope ON sj_positions;
CREATE POLICY sj_positions_scope ON sj_positions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(sj_positions.sj_id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_positions.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(sj_positions.sj_id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_positions.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

-- 203 set ALTER DEFAULT PRIVILEGES for app_user, so this is belt-and-braces
-- rather than strictly required — but an explicit grant costs nothing and makes
-- the table's reachability legible without cross-referencing another migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON sj_positions TO app_user;

COMMIT;
