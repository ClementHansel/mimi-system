-- Migration: 210_w2d_cloud_client_seq
-- Fix block: 2xx. Agent: W2-D (senior-integrator, kernel/sync).
-- Purpose: SYNC-PROTOCOL §1.5 — "the cloud is just another (privileged)
--          origin" for master-data edits and cloud-born decisions
--          (origin_tier='cloud', origin_device_id=well-known
--          '00000000-0000-0000-0000-0000000000c1'). Every origin needs a
--          durable, gapless, monotonic client_seq counter
--          (SYNC-PROTOCOL §2.1) — this sequence is that counter for the
--          cloud origin specifically. No new table/column: sync_events
--          (block 120-129, W1-C) already has no FK on origin_device_id, so
--          the well-known id needs no registry row; it only needs a source
--          of gapless numbers, which a plain Postgres SEQUENCE gives for
--          free (crash-safe, no double-issue under concurrent emits).
-- Created at: 2026-08-17

BEGIN;

CREATE SEQUENCE IF NOT EXISTS cloud_client_seq START WITH 1 INCREMENT BY 1;

COMMIT;
