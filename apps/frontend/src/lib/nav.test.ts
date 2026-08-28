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
    expect(interfaceForPath('/warehouse/stock', 'dashboard')?.id).toBe('warehouse');
    expect(interfaceForPath('/finance', 'warehouse')?.id).toBe('dashboard');
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
