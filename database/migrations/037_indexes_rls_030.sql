-- Migration: 037_indexes_rls_030
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: indexes + RLS for block 030-039.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_replenishment_requests_location ON replenishment_requests(location_id);
CREATE INDEX idx_replenishment_requests_status ON replenishment_requests(status);
CREATE INDEX idx_replenishment_requests_sj ON replenishment_requests(sj_id);
CREATE INDEX idx_replenishment_request_lines_item ON replenishment_request_lines(item_id);

CREATE INDEX idx_drivers_user ON drivers(user_id);
CREATE INDEX idx_drivers_employee ON drivers(employee_id);

CREATE INDEX idx_surat_jalan_origin ON surat_jalan(origin_location_id);
CREATE INDEX idx_surat_jalan_driver ON surat_jalan(driver_id);
CREATE INDEX idx_surat_jalan_vehicle ON surat_jalan(vehicle_id);
CREATE INDEX idx_surat_jalan_status ON surat_jalan(status);
CREATE INDEX idx_surat_jalan_planned_date ON surat_jalan(planned_date);

CREATE INDEX idx_sj_drops_sj ON sj_drops(sj_id);
CREATE INDEX idx_sj_drops_location ON sj_drops(location_id);
CREATE INDEX idx_sj_drops_request ON sj_drops(replenishment_request_id);
CREATE INDEX idx_sj_drops_status ON sj_drops(status);

CREATE INDEX idx_sj_lines_sj ON sj_lines(sj_id);
CREATE INDEX idx_sj_lines_drop ON sj_lines(drop_id);
CREATE INDEX idx_sj_lines_item ON sj_lines(item_id);

CREATE INDEX idx_sj_temperature_logs_sj ON sj_temperature_logs(sj_id);
CREATE INDEX idx_sj_temperature_logs_drop ON sj_temperature_logs(drop_id);
CREATE INDEX idx_sj_seals_sj ON sj_seals(sj_id);
CREATE INDEX idx_sj_seals_drop ON sj_seals(drop_id);

CREATE INDEX idx_goods_receipts_location ON goods_receipts(location_id);
CREATE INDEX idx_goods_receipts_ref ON goods_receipts(ref_id);
CREATE INDEX idx_goods_receipt_lines_receipt ON goods_receipt_lines(receipt_id);
CREATE INDEX idx_goods_receipt_lines_item ON goods_receipt_lines(item_id);

-- =============================================================================
-- RLS — replenishment_requests: LOC ; replenishment_request_lines: PARENT
-- =============================================================================

ALTER TABLE replenishment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY replenishment_requests_loc ON replenishment_requests FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE replenishment_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_request_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY replenishment_request_lines_parent ON replenishment_request_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM replenishment_requests r
      WHERE r.id = replenishment_request_lines.request_id AND app_has_location(r.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM replenishment_requests r
      WHERE r.id = replenishment_request_lines.request_id AND app_has_location(r.location_id)
    )
  );

-- =============================================================================
-- RLS — surat_jalan / sj_drops / sj_temperature_logs / sj_seals:
-- origin LOC OR any drop LOC OR (driver AND assigned)
-- =============================================================================

ALTER TABLE surat_jalan ENABLE ROW LEVEL SECURITY;
ALTER TABLE surat_jalan FORCE ROW LEVEL SECURITY;
CREATE POLICY surat_jalan_scope ON surat_jalan FOR ALL
  USING (
    app_has_location(origin_location_id)
    OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = surat_jalan.id AND app_has_location(d.location_id))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(origin_location_id)
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  );

ALTER TABLE sj_drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE sj_drops FORCE ROW LEVEL SECURITY;
CREATE POLICY sj_drops_scope ON sj_drops FOR ALL
  USING (
    app_has_location(location_id)
    OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = sj_drops.sj_id AND app_has_location(sj.origin_location_id))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(location_id)
    OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = sj_drops.sj_id AND app_has_location(sj.origin_location_id))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  );

ALTER TABLE sj_temperature_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sj_temperature_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY sj_temperature_logs_scope ON sj_temperature_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM surat_jalan sj
      WHERE sj.id = sj_temperature_logs.sj_id
        AND (
          app_has_location(sj.origin_location_id)
          OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = sj.id AND app_has_location(d.location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM drivers dr
              WHERE dr.id = sj.driver_id
                AND current_setting('app.user_id', true) IS NOT NULL
                AND dr.user_id = current_setting('app.user_id', true)::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);  -- inserted by origin/drop/driver actions; app layer picks the correct sj_id

ALTER TABLE sj_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sj_seals FORCE ROW LEVEL SECURITY;
CREATE POLICY sj_seals_scope ON sj_seals FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM surat_jalan sj
      WHERE sj.id = sj_seals.sj_id
        AND (
          app_has_location(sj.origin_location_id)
          OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = sj.id AND app_has_location(d.location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM drivers dr
              WHERE dr.id = sj.driver_id
                AND current_setting('app.user_id', true) IS NOT NULL
                AND dr.user_id = current_setting('app.user_id', true)::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);

-- =============================================================================
-- RLS — goods_receipts: LOC ; goods_receipt_lines: PARENT
-- =============================================================================

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipts_loc ON goods_receipts FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipt_lines_parent ON goods_receipt_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM goods_receipts r
      WHERE r.id = goods_receipt_lines.receipt_id AND app_has_location(r.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM goods_receipts r
      WHERE r.id = goods_receipt_lines.receipt_id AND app_has_location(r.location_id)
    )
  );

-- =============================================================================
-- RLS — drivers (coordinator amendment, post-§1.14): ScopeService needs to
-- resolve "is this user a driver, and which driver row is theirs" BEFORE
-- app.location_ids is set (two-phase session context: app.user_id/app.role
-- come straight off the verified JWT; app.location_ids is filled in by a
-- second, RLS-governed lookup). A self-scoped read policy makes that lookup
-- work under RLS instead of requiring an RLS exemption. Directory access for
-- staff who build/manage deliveries is preserved for delivery.read holders;
-- writes stay restricted to delivery.master.manage holders. Narrow scope
-- only: no self-write.
-- =============================================================================

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
CREATE POLICY drivers_select ON drivers FOR SELECT
  USING (
    current_setting('app.role', true) IN ('owner','manager','kepala_gudang','supervisor','leader_outlet')
    OR app_is_self(user_id)
  );
CREATE POLICY drivers_insert ON drivers FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));
CREATE POLICY drivers_update ON drivers FOR UPDATE
  USING (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));
CREATE POLICY drivers_delete ON drivers FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));

-- =============================================================================
-- NO RLS (§1.14 "NONE" group): vehicles, shipment_types — API-gated.
-- sj_lines is a PARENT-class table per §1.14 but has no location_id of its own;
-- it inherits sj_drops' scope via the drop_id join, same pattern as above.
-- =============================================================================

ALTER TABLE sj_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sj_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY sj_lines_parent ON sj_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sj_drops d
      WHERE d.id = sj_lines.drop_id
        AND (
          app_has_location(d.location_id)
          OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = d.sj_id AND app_has_location(sj.origin_location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM surat_jalan sj
              JOIN drivers dr ON dr.id = sj.driver_id
              WHERE sj.id = d.sj_id
                AND current_setting('app.user_id', true) IS NOT NULL
                AND dr.user_id = current_setting('app.user_id', true)::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);

COMMIT;
