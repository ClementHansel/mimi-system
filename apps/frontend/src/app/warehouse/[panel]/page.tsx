import { notFound } from 'next/navigation';
import { WAREHOUSE_PANELS } from '@/lib/warehouse-panels';
import { WarehousePanelPage } from '@/components/warehouse/WarehousePanelPage';

/**
 * One route per Gudang Pusat area, replacing the eight-tab strip.
 *
 * `generateStaticParams` is what makes the slug list a build-time fact rather
 * than a runtime string match: a link to a panel that does not exist fails
 * here, not by silently rendering an empty page.
 */
export function generateStaticParams() {
  return WAREHOUSE_PANELS.map((p) => ({ panel: p.slug }));
}

export default async function Page({ params }: { params: Promise<{ panel: string }> }) {
  const { panel } = await params;
  if (!WAREHOUSE_PANELS.some((p) => p.slug === panel)) notFound();
  return <WarehousePanelPage slug={panel} />;
}
