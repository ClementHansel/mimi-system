-- Migration: 211_w3_09_attendance_time_defensibility
-- Fix block: 2xx. Agent: W3-09 (medior, modules/hr).
-- Purpose: SYNC-PROTOCOL §6.3/§6.4 — attendance rows must carry the
--          `time_suspect` / `time_disputed` tags the protocol requires
--          ("records that fail that test are tagged time_suspect /
--          time_disputed for HR to work — never silently accepted and never
--          silently discarded"). CONTRACTS.md §4.14's `AttendanceRow`
--          response shape already has `timeSuspect: boolean`, but the block
--          060-069 DDL (CONTRACTS.md §1.7) never added the backing column —
--          a gap between the interface and the table, not a schema change
--          this agent invented. Also adds a second idempotency key for
--          check-out (the existing `client_id` column is check-in's; a
--          checked_out fact carries its own `clientId` per
--          packages/sync-protocol's schema registry and needs its own
--          unique slot so a replayed check-out dedupes instead of erroring
--          on a stale check-in's key), and the two `received_at` columns the
--          §6.4 `defensibleAt` clamp is computed against and that a
--          supervisor reviewing a `time_disputed` row needs to see.
-- Created at: 2026-08-17

BEGIN;

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS time_suspect BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS time_disputed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS check_in_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_out_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_out_client_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_check_out_client_id_key
  ON attendance (check_out_client_id)
  WHERE check_out_client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_time_disputed
  ON attendance (time_disputed)
  WHERE time_disputed = true;

COMMIT;
