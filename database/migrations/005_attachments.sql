-- Migration: 005_attachments
-- Block: 001-009 (core)
-- Description: MinIO object metadata; photo evidence everywhere (wajib foto).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket VARCHAR(50) NOT NULL DEFAULT 'mimi',
  object_key VARCHAR(500) UNIQUE NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 VARCHAR(64),
  entity_type VARCHAR(100),                      -- e.g. 'sj_drop', 'waste_record', 'attendance'
  entity_id UUID,
  kind VARCHAR(50) NOT NULL,                     -- 'receiving_photo','selfie','waste_photo','payment_proof',
                                                  -- 'service_proof','signature','petty_cash_photo','return_proof','slip_pdf','sj_pdf'
  location_id UUID REFERENCES locations(id),
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
