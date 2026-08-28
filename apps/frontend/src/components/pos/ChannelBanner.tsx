'use client';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CHANNEL_META } from './channel-meta';
import { usePosChannelStore } from './channel-store';

/**
 * F-POS-3 — a second, redundant "which channel is this?" signal, on top of
 * `ChannelToggle`'s own active-state colouring. Renders NOTHING for walk-in
 * (the ordinary case needs no extra noise) but a full-width, hard-to-miss
 * coloured strip for GoFood/ShopeeFood — mirroring `OfflineBanner`'s
 * pattern of "silent when normal, loud when the till is in a state that can
 * cost money if unnoticed." Mounted once in `app/pos/layout.tsx`, above
 * every tab (Kasir AND Shift), so switching to the Shift tab mid-GoFood-run
 * never quietly drops the "you're still in GoFood mode" reminder off
 * screen.
 */
export function ChannelBanner({ className }: { className?: string }) {
  const { t } = useI18n();
  const channel = usePosChannelStore((s) => s.channel);

  if (channel === 'walk_in') return null;

  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-sm font-semibold',
        meta.badgeClass,
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
      {t('pos.channelBannerActive', { channel: t(meta.labelKey) })}
    </div>
  );
}
