-- =============================================================================
-- W7 — attendance geofence: 200 m, and the SETTING is finally the default.
--
-- Owner's ruling (2026-08-21): "we need to make the attendance system properly
-- so it can be geo fenced at 200M of the outlet location using each personal
-- interface."
--
-- Two separate problems behind that sentence.
--
-- 1. THE RADIUS. Everything shipped at 100 m: `settings('hr.geofence_radius_m')`
--    said 100, `locations.geofence_radius_m` defaulted to 100, and all 21
--    seeded locations carried exactly 100. A 100 m circle is tight for a
--    roadside outlet in Kalimantan — a phone's civilian GPS fix is routinely
--    20-50 m off, worse under a canopy or beside a building, so a cashier
--    standing at the till was one bad fix away from being unable to clock in,
--    and POUT-01..03 turn a failed check-in into an *alpha* — a wage deduction.
--    200 m is the owner's number.
--
-- 2. THE SETTING DID NOTHING. `settings('hr.geofence_radius_m')` describes
--    itself as "Default attendance geofence radius; overridable per location",
--    but `AttendanceService.resolveLocation` read `locations.geofence_radius_m`
--    and nothing else. Because that column was NOT NULL DEFAULT 100, every row
--    always carried a value, so the column was ALWAYS authoritative and the
--    setting was decorative: an owner changing 100 to 200 in Pengaturan would
--    have seen no effect anywhere, with no error to explain why.
--
--    Fixed structurally rather than by "remember to update both": the column
--    becomes NULLABLE, where NULL means INHERIT THE SETTING, and every row
--    still sitting on the old 100 m default is set to NULL — they were never
--    deliberate overrides, they were the default wearing a value. A row with a
--    number in it now genuinely means "this outlet is different", which is
--    what the word override has to mean for the setting to be usable.
--
-- The 200 m default therefore lands in ONE place (the setting), and moving it
-- again is a Pengaturan edit, not a migration.
-- =============================================================================

BEGIN;

-- 1. The setting becomes the single source of the default.
UPDATE settings
   SET value = '200'::jsonb,
       description = 'Default attendance geofence radius in metres (FR-HR-01). Applies to every location whose own geofence_radius_m is NULL; a per-location value overrides it.'
 WHERE key = 'hr.geofence_radius_m';

-- 2. NULL now means "inherit the setting".
ALTER TABLE locations
  ALTER COLUMN geofence_radius_m DROP NOT NULL,
  ALTER COLUMN geofence_radius_m DROP DEFAULT;

COMMENT ON COLUMN locations.geofence_radius_m IS
  'Per-location attendance geofence radius in metres, or NULL to inherit settings(hr.geofence_radius_m). NULL is the normal case.';

-- 3. Every location still on the old 100 m default was never an override.
--    Scoped to = 100 on purpose: if someone had already set a deliberate 50 m
--    or 400 m, that is a real decision and this migration must not erase it.
UPDATE locations
   SET geofence_radius_m = NULL
 WHERE geofence_radius_m = 100;

COMMIT;
