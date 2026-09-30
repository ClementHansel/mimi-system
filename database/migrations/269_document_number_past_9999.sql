-- Migration: 269_document_number_past_9999
-- Fix block: 2xx. allocate_document_number (215) formatted the sequence with
--             LPAD(v_next::text, 4, '0'). Postgres LPAD TRUNCATES a string
--             longer than the target length, so the 10 000th document of a
--             month came back as '…/1000' — the SAME number as the 1 000th —
--             and the insert died on the document's unique key.
--
-- Found loading the client's April 2026 period: ~11 000 journal entries in one
-- month (one per waste record, as the app itself posts them). JE/202604/10000
-- was allocated as JE/202604/1000.
--
-- The pad width is now "at least 4": every number the old function could
-- return correctly (1-9999) is byte-identical, and 10000+ is no longer cut.
-- Created at: 2026-10-01

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

  RETURN p_doc_type || '/' || p_period || '/'
      || LPAD(v_next::text, GREATEST(4, length(v_next::text)), '0');
END;
$$;

COMMIT;
