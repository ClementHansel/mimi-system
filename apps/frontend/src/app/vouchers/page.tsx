import { VoucherBatchesPanel } from '@/components/vouchers/VoucherBatchesPanel';

/**
 * Voucher management — the promotional-coupon batches head office prints,
 * issues and closes (`voucher.read`/`.manage`/`.issue`; redemption itself is
 * a POS payment-screen concern, `voucher.redeem`, and has no page here). See
 * `components/vouchers/VoucherBatchesPanel` for the list + create/edit +
 * detail flow.
 */
export default function VouchersPage() {
  return <VoucherBatchesPanel />;
}
