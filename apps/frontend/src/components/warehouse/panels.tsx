'use client';

import type { ReactNode } from 'react';
import { WAREHOUSE_PANELS } from '@/lib/warehouse-panels';
import { ApprovalQueuePanel } from './ApprovalQueuePanel';
import { OutboundPanel } from './OutboundPanel';
import { StockPanel } from './StockPanel';
import { ReceivingPanel } from './ReceivingPanel';
import { StockOpnamePanel } from './StockOpnamePanel';
import { WastePanel } from './WastePanel';
import { ReturnPanel } from './ReturnPanel';

/**
 * slug -> the component that renders that Gudang area.
 *
 * Separate from `lib/warehouse-panels.ts`, which carries the labels, icons and
 * permissions the SIDEBAR needs. Keeping the components out of that module is
 * what stops `nav.ts` — imported by every page — from pulling in eight panels
 * and everything they depend on.
 *
 * Keyed by the same slugs, and the test below the registry asserts the two
 * lists agree, so a new area cannot be routable with nothing to render.
 */
const PANEL_COMPONENTS: Record<string, () => ReactNode> = {
  approvals: () => <ApprovalQueuePanel />,
  stock: () => <StockPanel />,
  receiving: () => <ReceivingPanel />,
  opname: () => <StockOpnamePanel />,
  waste: () => <WastePanel />,
  retur: () => <ReturnPanel />,
  pengiriman: () => <OutboundPanel />,
  // No `rekap` entry: the daily recap is a tab of `DeliveryShell` now, not a
  // Gudang panel (see `lib/warehouse-panels.ts`'s note). `RecapPanel` itself
  // still lives in this folder — it reads through `lib/warehouse-api.ts` — and
  // is imported directly by the delivery shell.
};

export function renderWarehousePanel(slug: string): ReactNode | null {
  return PANEL_COMPONENTS[slug]?.() ?? null;
}

export function warehousePanelMeta(slug: string) {
  return WAREHOUSE_PANELS.find((p) => p.slug === slug);
}
