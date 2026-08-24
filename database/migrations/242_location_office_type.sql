-- Migration: 242_location_office_type
-- Block: 001-009 (core). Adds 'office' to `locations.type`'s CHECK constraint
-- (migration 002_locations_storage_areas.sql).
--
-- WHY: F10 admin ticket "Locations CRUD" (2026-08-24) — the business has
-- back-office sites (Kalimantan admin offices) that are neither a gudang nor
-- a retail outlet, but still need a row in `locations` because attendance
-- geofencing (FR-HR-01) keys off THIS table for every employee, wherever they
-- clock in. Before this migration `type` only allowed 'warehouse'/'outlet',
-- so an office had no legal row to sit in and no geofence at all.
--
-- The constraint dropped below is the one Postgres auto-named
-- `locations_type_check` when migration 002 declared it inline
-- (`type VARCHAR(20) NOT NULL CHECK (type IN ('warehouse','outlet'))`) — no
-- prior migration has touched it, so this is still its name.
--
-- No data fix needed: every existing row is already 'warehouse' or 'outlet',
-- both of which remain valid.
-- Created at: 2026-08-24

BEGIN;

ALTER TABLE locations DROP CONSTRAINT locations_type_check;
ALTER TABLE locations ADD CONSTRAINT locations_type_check
  CHECK (type IN ('warehouse', 'outlet', 'office'));

COMMIT;
