'use client';

import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { EmptyState } from '@/components/ui';
import { renderWarehousePanel, warehousePanelMeta } from './panels';

/**
 * Renders one Gudang Pusat area, and refuses to render it to someone without
 * the permission its old tab checked.
 *
 * That check has to survive the move from tabs to routes. A hidden tab was
 * unreachable because the strip never drew it; a ROUTE is reachable by typing
 * the URL. The endpoint guards are still the real boundary — this is about not
 * showing someone a screen full of failed requests.
 */
export function WarehousePanelPage({ slug }: { slug: string }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const meta = warehousePanelMeta(slug);

  if (!meta) return <EmptyState title={t('table.error')} size="lg" />;
  if (!can(meta.permission)) return <EmptyState title={t('common.noAccess')} size="lg" />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t(meta.labelKey)}</h1>
      {renderWarehousePanel(slug)}
    </div>
  );
}
