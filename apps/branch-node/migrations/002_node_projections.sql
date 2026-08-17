-- Branch-node local schema, part 2: the whitelist-apply projections
-- (SYNC-PROTOCOL §1.4 table — "What the node applies vs. relays opaquely").
-- The node stores/forwards ALL events verbatim (part 1's sync_events), but
-- only PROJECTS this whitelist: master data (for LAN catalog serving with
-- cloud down), a generic latest-snapshot cache for intra-outlet visibility
-- entities (sales/pos_shifts/replenishment_requests/attendance/...), and the
-- shared D-16a stock projector's movement log for the node-local per-area
-- stock view. None of these are the cloud's authoritative row shapes —
-- they are this node's own derived read models, rebuildable from
-- sync_events at any time.

-- Class-M master-data cache: generic (entity, entity_id) -> latest payload.
-- One table for every master-data entity rather than one table per entity —
-- the node never interprets these payloads beyond passing them through to
-- LAN devices' bootstrap/pull responses, so a fixed relational shape per
-- entity would buy nothing.
CREATE TABLE IF NOT EXISTS master_data_cache (
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity, entity_id)
);

-- The whitelisted F/B entities' latest-known-state, for LAN fan-out
-- visibility (§1.4: "second tablet sees first tablet's shift/sales",
-- "outlet staff see request status on any device", "supervisor sees
-- today's check-ins on LAN"). Same generic-cache shape as master data,
-- plus location_id so a device can be served only its own outlet's rows.
CREATE TABLE IF NOT EXISTS entity_projections (
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  location_id UUID,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_projections_location ON entity_projections (entity, location_id);

-- Node-local derived stock movements (D-16a): the SAME `MovementFact` shape
-- `packages/sync-protocol`'s shared projector produces, applied here from
-- whitelisted facts (sj_drops.received, goods_receipts.recorded,
-- waste_records approved, stock_opname adjustments, stock_adjustments.posted,
-- returns, sales.completed's recipe explosion). Deduplicated by `fact_id` —
-- replaying the same fact twice changes nothing (T-02). `stock_balances`
-- itself is NEVER a table here (D-16): the balance is always folded from
-- this movement log on read, exactly as CONTRACTS.md/SYNC-PROTOCOL mandate
-- for every tier.
CREATE TABLE IF NOT EXISTS stock_movements (
  fact_id TEXT PRIMARY KEY,
  location_id UUID NOT NULL,
  storage_area_id UUID NOT NULL,
  item_id UUID NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  qty NUMERIC(14, 3) NOT NULL,
  unit_cost NUMERIC(18, 2) NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_key ON stock_movements (location_id, storage_area_id, item_id);
