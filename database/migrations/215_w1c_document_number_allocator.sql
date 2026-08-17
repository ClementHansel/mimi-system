-- Migration: 215_w1c_document_number_allocator
-- Fix block: 2xx. Bug found by W3-07 (cost most of a session, fixed only
--             data-side in the running Postgres, so it recurred on every
--             db:reset): seed.ts hardcoded document numbers (e.g.
--             'SJ/202608/0001') without ever writing the matching
--             document_counters row (007 creates the table, seeds nothing
--             into it). The first real `nextDocNumber('SJ')` allocation
--             then collides with the seed's hardcoded value on
--             surat_jalan_sj_number_key.
--
-- Root cause, precisely: two sources of truth for the same sequence — a
-- hardcoded literal in seed.ts and document_counters' last_number — with
-- nothing keeping them in step. The fix is not to seed a "correct" starting
-- value into document_counters (that just relocates the same bug: two
-- places that must agree, one of them a human-maintained literal); it is to
-- give both the seed AND the eventual application exactly one mechanism
-- that can ever produce a document number, so they cannot disagree by
-- construction.
--
-- allocate_document_number(doc_type, period) atomically increments
-- document_counters (creating the row on first use) and returns the fully
-- formatted number, in the exact `<PREFIX>/<YYYYMM>/<seq>` shape
-- CONTRACTS.md §0 specifies (e.g. 'SJ/202608/0042'). This is now THE
-- canonical numbering path for this schema — seed.ts is updated in this
-- same change to call it instead of hardcoding, and the eventual M20/
-- kernel document-numbering service should call this function rather than
-- reimplementing the upsert-and-increment logic in application code, so
-- the two can never drift apart again.
--
-- Concurrency: the INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a
-- single atomic statement — Postgres serializes concurrent callers on the
-- same (doc_type, period) row via the row lock taken by the upsert, so two
-- simultaneous allocations for the same period can never receive the same
-- number.
-- Created at: 2026-08-17

BEGIN;

CREATE OR REPLACE FUNCTION allocate_document_number(p_doc_type VARCHAR(30), p_period VARCHAR(6))
RETURNS VARCHAR(30)
LANGUAGE plpgsql
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  INSERT INTO document_counters (doc_type, period, last_number)
  VALUES (p_doc_type, p_period, 1)
  ON CONFLICT (doc_type, period)
  DO UPDATE SET last_number = document_counters.last_number + 1
  RETURNING last_number INTO v_next;

  RETURN p_doc_type || '/' || p_period || '/' || LPAD(v_next::text, 4, '0');
END;
$$;

COMMIT;
