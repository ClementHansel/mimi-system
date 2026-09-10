import { describe, expect, it } from 'vitest';
import { ALL_NAV_ITEMS, INTERFACES, interfaceForPath } from './nav';
import { WAREHOUSE_PANELS } from './warehouse-panels';

function iface(id: string) {
  const found = INTERFACES.find((i) => i.id === id);
  if (!found) throw new Error(`no interface ${id}`);
  return found;
}

function hrefs(id: string): string[] {
  return iface(id).sections.flatMap((section) => section.items.map((item) => item.href));
}

describe('interfaceForPath — shared surfaces keep you where you were', () => {
  it('keeps a gudang user in gudang when they open Pembelian', () => {
    // The reported bug: `/purchasing` was listed in the DASHBOARD's owned
    // routes while also sitting in gudang's sidebar, so tapping it swapped the
    // whole sidebar and the way back to Stok Gudang disappeared.
    expect(interfaceForPath('/purchasing', 'warehouse')?.id).toBe('warehouse');
  });

  it('keeps an office user in the dashboard when they open Pembelian', () => {
    expect(interfaceForPath('/purchasing', 'dashboard')?.id).toBe('dashboard');
  });

  it('falls back to the dashboard for a cold load of Pembelian', () => {
    expect(interfaceForPath('/purchasing', null)?.id).toBe('dashboard');
  });

  it('resolves both sidebars that actually offer Pembelian', () => {
    expect(hrefs('warehouse')).toContain('/purchasing');
    expect(hrefs('dashboard')).toContain('/purchasing');
  });

  it('still keeps Surat Jalan shared the same way', () => {
    expect(interfaceForPath('/delivery', 'warehouse')?.id).toBe('warehouse');
    expect(interfaceForPath('/delivery', 'dashboard')?.id).toBe('dashboard');
  });

  it('treats the dispatcher shell tabs as the same shared surface', () => {
    // `/delivery/assign` and `/delivery/rekap` are tabs of one screen, so they
    // must not teleport a gudang user into the office's sidebar either.
    expect(interfaceForPath('/delivery/assign', 'warehouse')?.id).toBe('warehouse');
    expect(interfaceForPath('/delivery/rekap', 'warehouse')?.id).toBe('warehouse');
  });

  it('resolves an unshared route by its own interface regardless of history', () => {
    // Was `/warehouse/stock`, which is now deliberately SHARED (the office has
    // its own Stok Gudang entry). `/warehouse/opname` replaces it as the
    // exemplar: stock opname is gudang's work, offered by no other sidebar.
    expect(interfaceForPath('/warehouse/opname', 'dashboard')?.id).toBe('warehouse');
    expect(interfaceForPath('/finance', 'warehouse')?.id).toBe('dashboard');
  });
});

describe('Stok Gudang is readable from the office without leaving it', () => {
  // Owner, 2026-09-10: "add menu in the office to see the stocks in gudang
  // too." The screen already existed at `/warehouse/stock`; what was missing
  // was a way into it that did not dump an office user into gudang's sidebar.

  it('offers the entry in BOTH sidebars, from one panel definition', () => {
    expect(hrefs('dashboard')).toContain('/warehouse/stock');
    expect(hrefs('warehouse')).toContain('/warehouse/stock');
  });

  it('keeps an office user in the dashboard when they open it', () => {
    expect(interfaceForPath('/warehouse/stock', 'dashboard')?.id).toBe('dashboard');
  });

  it('keeps a gudang user in gudang when they open it', () => {
    expect(interfaceForPath('/warehouse/stock', 'warehouse')?.id).toBe('warehouse');
  });

  it('falls back to gudang on a cold load — the stock is theirs', () => {
    expect(interfaceForPath('/warehouse/stock', null)?.id).toBe('warehouse');
  });

  it('shares ONLY the stock panel, never the rest of gudang', () => {
    // `SHARED_ROUTES` matches on prefix, so a `/warehouse` entry would have
    // pulled every gudang work surface into the office interface. Each of
    // these must still resolve to gudang even for an office user.
    for (const slug of ['opname', 'waste', 'retur', 'receiving', 'pengiriman', 'approvals']) {
      expect(interfaceForPath(`/warehouse/${slug}`, 'dashboard')?.id).toBe('warehouse');
    }
    expect(interfaceForPath('/warehouse', 'dashboard')?.id).toBe('warehouse');
  });

  it("carries gudang's own label, icon and permission — no second definition to drift", () => {
    const panel = WAREHOUSE_PANELS.find((entry) => entry.slug === 'stock');
    const office = iface('dashboard')
      .sections.flatMap((section) => section.items)
      .find((item) => item.href === '/warehouse/stock');
    expect(panel).toBeDefined();
    expect(office).toBeDefined();
    expect(office!.labelKey).toBe(panel!.labelKey);
    expect(office!.icon).toBe(panel!.icon);
    expect(office!.permission).toBe(panel!.permission);
  });

  it("sits in the office's Logistik & Gudang section, not a new one", () => {
    const section = iface('dashboard').sections.find((entry) => entry.id === 'logistik');
    expect(section).toBeDefined();
    expect(section!.items.map((item) => item.href)).toEqual([
      '/warehouse/stock',
      '/delivery',
      '/purchasing',
    ]);
  });
});

describe('Rekap Harian is combined into the dispatcher surface', () => {
  it('is no longer a Gudang panel or a sidebar entry', () => {
    // Owner, 2026-08-27: the recap, Pengiriman (Dispatcher) and Penugasan
    // Pengiriman "need to be combined like dashboard" — one surface, tabs
    // across it. Two nav entries for the same job is the thing that was wrong.
    expect(WAREHOUSE_PANELS.map((p) => p.slug)).not.toContain('rekap');
    expect(hrefs('warehouse')).not.toContain('/warehouse/rekap');
  });

  it('leaves no sidebar entry for Penugasan Pengiriman either', () => {
    expect(ALL_NAV_ITEMS.map((i) => i.href)).not.toContain('/delivery/assign');
    expect(ALL_NAV_ITEMS.map((i) => i.href)).not.toContain('/delivery/rekap');
  });

  it('keeps one entry that reaches all of them', () => {
    expect(hrefs('warehouse')).toContain('/delivery');
  });
});

describe('nav inventory', () => {
  it('has no duplicate hrefs', () => {
    const seen = ALL_NAV_ITEMS.map((i) => i.href);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('lists every Gudang panel exactly once', () => {
    const warehouse = hrefs('warehouse');
    for (const panel of WAREHOUSE_PANELS) {
      expect(warehouse.filter((h) => h === `/warehouse/${panel.slug}`)).toHaveLength(1);
    }
  });
});
