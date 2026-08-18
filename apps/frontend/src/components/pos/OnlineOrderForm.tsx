'use client';

import { useMemo, useState } from 'react';
import { calculateOnlineOrderNet, isNegativeMoney, ZERO_MONEY, SyncEntity } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { Button, Input, MoneyInput, Select, Card, CardContent } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { formatMoney } from '@/lib/formatters';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money, UUID } from '@/lib/shared-types';
import { mintClientId } from './pos-runtime';

/**
 * GoFood/ShopeeFood manual entry (FR-POS-05/07, SYNC-PROTOCOL §8 row 17 —
 * fully local in every connectivity tier). `netReceived` is always the
 * `@mimi/shared` cart-calculator's `calculateOnlineOrderNet`
 * (`gross − discount − platformFee − otherFee`), shown live and locked —
 * the cashier enters the platform's own line items, never types the net
 * itself, so it can't drift from what `POST /api/pos/online-orders`
 * (`ERR_NET_MISMATCH`) will accept once synced.
 */
export function OnlineOrderForm({
  runtime,
  actor,
  locationId,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  locationId: UUID;
}) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<'gofood' | 'shopeefood'>('gofood');
  const [orderRef, setOrderRef] = useState('');
  const [gross, setGross] = useState<Money | null>(null);
  const [discount, setDiscount] = useState<Money | null>(null);
  const [platformFee, setPlatformFee] = useState<Money | null>(null);
  const [otherFee, setOtherFee] = useState<Money | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const amounts = {
    grossAmount: gross ?? ZERO_MONEY,
    discountAmount: discount ?? ZERO_MONEY,
    platformFee: platformFee ?? ZERO_MONEY,
    otherFee: otherFee ?? ZERO_MONEY,
  };
  const net = useMemo(
    () => calculateOnlineOrderNet(amounts),
    [amounts.grossAmount, amounts.discountAmount, amounts.platformFee, amounts.otherFee],
  );
  const netIsNegative = isNegativeMoney(net);

  async function handleSubmit() {
    if (!gross || !orderRef.trim()) {
      toast({ title: t('validation.required'), variant: 'danger' });
      return;
    }
    setSubmitting(true);
    try {
      const orderId = mintClientId();
      await runtime.enqueueFact({
        entity: SyncEntity.ONLINE_ORDERS,
        op: 'recorded',
        entityId: orderId,
        data: {
          clientId: orderId,
          locationId,
          platform,
          orderRef,
          orderDate: new Date().toISOString().slice(0, 10),
          grossAmount: amounts.grossAmount,
          discountAmount: amounts.discountAmount,
          platformFee: amounts.platformFee,
          otherFee: amounts.otherFee,
          netReceived: net,
          status: 'completed',
        },
        actor,
      });
      toast({ title: t('pos.onlineOrderSavedTitle'), variant: 'success' });
      setOrderRef('');
      setGross(null);
      setDiscount(null);
      setPlatformFee(null);
      setOtherFee(null);
    } catch (err) {
      toast({
        title: t('pos.onlineOrderFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="flex flex-col gap-4">
        <Select
          label={t('pos.platform')}
          value={platform}
          onValueChange={(v) => setPlatform(v as 'gofood' | 'shopeefood')}
          options={[
            { value: 'gofood', label: 'GoFood' },
            { value: 'shopeefood', label: 'ShopeeFood' },
          ]}
        />
        <Input
          label={t('pos.orderRef')}
          value={orderRef}
          onChange={(e) => setOrderRef(e.target.value)}
          required
        />
        <MoneyInput
          label={t('pos.grossAmount')}
          value={gross}
          onChange={setGross}
          required
          size="touch"
        />
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label={t('pos.discountAmount')} value={discount} onChange={setDiscount} />
          <MoneyInput label={t('pos.platformFee')} value={platformFee} onChange={setPlatformFee} />
        </div>
        <MoneyInput
          label={t('pos.otherFee')}
          value={otherFee}
          onChange={setOtherFee}
          hint={t('common.optional')}
        />
        <div className="flex items-center justify-between rounded-md bg-surface-sunken p-3 text-base font-semibold">
          <span>{t('pos.netReceived')}</span>
          <span className={netIsNegative ? 'text-danger-600' : 'text-text-primary'}>
            {formatMoney(net)}
          </span>
        </div>
        <Button
          size="touch-lg"
          fullWidth
          loading={submitting}
          disabled={!gross || netIsNegative}
          onClick={handleSubmit}
        >
          {t('pos.onlineOrderSave')}
        </Button>
      </CardContent>
    </Card>
  );
}
