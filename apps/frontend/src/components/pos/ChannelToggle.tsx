'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button } from '@/components/ui';
import { priceForChannel } from './channel-pricing';
import { CHANNEL_META } from './channel-meta';
import { usePosChannelStore } from './channel-store';
import { usePosCartStore } from './cart-store';
import type { PosChannel, PosProduct } from './types';

/**
 * F-POS-3 — the toggle that replaces the old "Kasir" / "GoFood/ShopeeFood"
 * tab pair (owner: "need only 1 interface for 3 of them"). This is the
 * single highest-risk control on the whole screen: a mis-tap here charges
 * every item in the sale at the wrong price. Two design choices follow
 * directly from that risk, not from taste:
 *
 * 1. Three ALWAYS-VISIBLE, ALWAYS-LABELLED buttons, not a dropdown or a
 *    single cycling toggle — the active channel must be readable without
 *    interaction, and choosing wrong must be a deliberate tap on a
 *    correctly-labelled target, never "tap until the label you want shows
 *    up." Each channel also gets its own colour (see `CHANNEL_META`) so the
 *    active state is visible even to someone glancing from across the
 *    counter, not just to whoever is looking directly at the label text.
 *
 * 2. Switching channel with a NON-EMPTY cart asks first (`ConfirmModal`
 *    below) instead of either (a) silently re-pricing every line — a
 *    cashier could switch by accident and never notice the total just
 *    changed underneath them — or (b) refusing the switch outright — which
 *    would force voiding and re-entering a sale any time a cashier picked
 *    the wrong channel first, a real everyday mistake this otherwise makes
 *    easy to fix. Confirming makes the reprice a deliberate, visible act
 *    with the old and new totals both on screen, and declining leaves the
 *    cart and channel exactly as they were. An EMPTY cart switches
 *    instantly — there's nothing to reprice and nothing to lose.
 */
export function ChannelToggle({ products }: { products: PosProduct[] }) {
  const { t } = useI18n();
  const channel = usePosChannelStore((s) => s.channel);
  const setChannel = usePosChannelStore((s) => s.setChannel);
  const lines = usePosCartStore((s) => s.lines);
  const repriceForChannel = usePosCartStore((s) => s.repriceForChannel);
  const [pendingChannel, setPendingChannel] = useState<PosChannel | null>(null);

  function requestSwitch(next: PosChannel) {
    if (next === channel) return;
    if (lines.length === 0) {
      setChannel(next);
      return;
    }
    setPendingChannel(next);
  }

  function confirmSwitch() {
    if (!pendingChannel) return;
    const next = pendingChannel;
    repriceForChannel((productId) => {
      const product = products.find((p) => p.id === productId);
      return product ? priceForChannel(product, next) : undefined;
    });
    setChannel(next);
    setPendingChannel(null);
  }

  return (
    <>
      <div
        role="group"
        aria-label={t('pos.channelToggleLabel')}
        className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-raised p-1"
      >
        {(Object.keys(CHANNEL_META) as PosChannel[]).map((c) => {
          const meta = CHANNEL_META[c];
          const Icon = meta.icon;
          const active = channel === c;
          return (
            <button
              key={c}
              type="button"
              aria-pressed={active}
              onClick={() => requestSwitch(c)}
              className={`flex min-h-touch items-center gap-1.5 rounded-md border-2 px-3 text-sm font-semibold transition-colors ${
                active
                  ? meta.activeClass
                  : 'border-transparent text-text-secondary hover:bg-surface-sunken'
              }`}
            >
              <Icon className="size-4" aria-hidden />
              {t(meta.labelKey)}
            </button>
          );
        })}
      </div>

      <Modal
        open={pendingChannel !== null}
        onClose={() => setPendingChannel(null)}
        title={t('pos.channelSwitchConfirmTitle')}
        description={
          pendingChannel
            ? t('pos.channelSwitchConfirmDescription', {
                channel: t(CHANNEL_META[pendingChannel].labelKey),
              })
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingChannel(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmSwitch}>{t('pos.channelSwitchConfirmSubmit')}</Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">{t('pos.channelSwitchConfirmBody')}</p>
      </Modal>
    </>
  );
}
