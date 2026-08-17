'use client';

import {
  Circle, Send, Clock, CheckCircle2, XCircle, Ban, Loader2, Truck, PackageCheck, Lock,
  ArrowRightCircle, SkipForward, CalendarClock, LogOut, Thermometer, Info, Wrench,
  AlertTriangle, RefreshCcw, Wifi, WifiOff, Unlink, HelpCircle, type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * ONE component for every document/entity status in CONTRACTS.md §2 — this is
 * the "single StatusBadge, driven by the status enums" component the brief
 * asks for. `domain` selects the i18n label namespace (`status.<domain>.*` in
 * `lib/i18n/id.ts`, mirroring §2's enum groupings); `status` is the raw wire
 * value (e.g. `"awaiting_approval"`).
 *
 * Tone+icon come from ONE flat vocabulary table below, because the ~90 status
 * strings across 29 enums never actually need different visual treatment for
 * the same word (draft is always neutral, approved is always success, …) —
 * only the *label wording* differs per domain, which is why that part alone
 * is namespaced. An unrecognized value (schema drift, additive versioning
 * per SYNC-PROTOCOL §2.3) never crashes: it falls back to a neutral dot and a
 * prettified version of the raw string instead of an empty badge.
 *
 * Accessibility (NFR / VISUAL DIRECTION brief): color is never the only
 * signal — every tone pairs a fixed icon with the label text, so approval
 * state and stock alerts stay legible for color-blind staff.
 */

export type StatusDomain =
  | 'replenishment' | 'suratJalan' | 'drop' | 'opname' | 'waste' | 'return'
  | 'purchaseRequest' | 'purchaseOrder' | 'pettyCash' | 'shift' | 'sale' | 'payment'
  | 'voidRefund' | 'onlineOrder' | 'settlement' | 'approval' | 'approvalStep'
  | 'employment' | 'attendance' | 'leave' | 'payrollRun' | 'loan' | 'asset'
  | 'maintenanceJob' | 'fiscalPeriod' | 'journalEntry' | 'device' | 'reverification'
  | 'offlineAuthOutcome';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
  info: 'bg-info-50 text-info-700',
  neutral: 'bg-stone-100 text-stone-600',
};

const VOCAB: Record<string, { tone: Tone; icon: LucideIcon }> = {
  draft: { tone: 'neutral', icon: Circle },
  submitted: { tone: 'info', icon: Send },
  awaiting_approval: { tone: 'warning', icon: Clock },
  pending: { tone: 'warning', icon: Clock },
  pending_approval: { tone: 'warning', icon: Clock },
  pending_verification: { tone: 'warning', icon: Clock },
  approved: { tone: 'success', icon: CheckCircle2 },
  verified: { tone: 'success', icon: CheckCircle2 },
  rejected: { tone: 'danger', icon: XCircle },
  failed: { tone: 'danger', icon: XCircle },
  cancelled: { tone: 'neutral', icon: Ban },
  processing: { tone: 'info', icon: Loader2 },
  counting: { tone: 'info', icon: Loader2 },
  in_progress: { tone: 'info', icon: Loader2 },
  loading: { tone: 'info', icon: Loader2 },
  shipped: { tone: 'info', icon: Truck },
  in_transit: { tone: 'info', icon: Truck },
  en_route: { tone: 'info', icon: Truck },
  ready: { tone: 'info', icon: PackageCheck },
  received: { tone: 'success', icon: PackageCheck },
  arrived: { tone: 'success', icon: PackageCheck },
  completed: { tone: 'success', icon: CheckCircle2 },
  done: { tone: 'success', icon: CheckCircle2 },
  paid: { tone: 'success', icon: CheckCircle2 },
  settled: { tone: 'success', icon: CheckCircle2 },
  closed: { tone: 'neutral', icon: Lock },
  converted: { tone: 'info', icon: ArrowRightCircle },
  adjusted: { tone: 'success', icon: CheckCircle2 },
  completed_discrepancy: { tone: 'warning', icon: AlertTriangle },
  skipped: { tone: 'neutral', icon: SkipForward },
  scheduled: { tone: 'neutral', icon: CalendarClock },
  due: { tone: 'warning', icon: Clock },
  active: { tone: 'success', icon: CheckCircle2 },
  open: { tone: 'info', icon: Circle },
  probation: { tone: 'warning', icon: Clock },
  resigned: { tone: 'neutral', icon: LogOut },
  terminated: { tone: 'danger', icon: XCircle },
  present: { tone: 'success', icon: CheckCircle2 },
  late: { tone: 'warning', icon: Clock },
  absent: { tone: 'danger', icon: XCircle },
  sick: { tone: 'warning', icon: Thermometer },
  permission: { tone: 'info', icon: Info },
  leave: { tone: 'info', icon: CalendarClock },
  holiday: { tone: 'neutral', icon: Circle },
  off: { tone: 'neutral', icon: Circle },
  calculated: { tone: 'info', icon: Loader2 },
  paid_off: { tone: 'success', icon: CheckCircle2 },
  written_off: { tone: 'neutral', icon: Ban },
  in_maintenance: { tone: 'warning', icon: Wrench },
  retired: { tone: 'neutral', icon: Ban },
  lost: { tone: 'danger', icon: AlertTriangle },
  partially_received: { tone: 'warning', icon: PackageCheck },
  issued: { tone: 'info', icon: Send },
  voided: { tone: 'danger', icon: Ban },
  refunded: { tone: 'warning', icon: RefreshCcw },
  posted: { tone: 'success', icon: CheckCircle2 },
  reversed: { tone: 'warning', icon: RefreshCcw },
  locked: { tone: 'neutral', icon: Lock },
  online: { tone: 'success', icon: Wifi },
  stale: { tone: 'warning', icon: WifiOff },
  offline: { tone: 'neutral', icon: WifiOff },
  unpaired: { tone: 'neutral', icon: Unlink },
  unprovable: { tone: 'warning', icon: HelpCircle },
};

function prettify(raw: string): string {
  return raw
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface StatusBadgeProps {
  domain: StatusDomain;
  status: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusBadge({ domain, status, size = 'md', className }: StatusBadgeProps) {
  const { t } = useI18n();
  const key = `status.${domain}.${status}`;
  const translated = t(key);
  const label = translated === key ? prettify(status) : translated;
  const meta = VOCAB[status] ?? { tone: 'neutral' as const, icon: Circle };
  const Icon = meta.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      <Icon className={cn(size === 'sm' ? 'size-3' : 'size-3.5', status === 'processing' && 'animate-spin')} aria-hidden />
      {label}
    </span>
  );
}
