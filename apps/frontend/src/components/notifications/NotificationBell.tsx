'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { cn } from '@/lib/utils';
import { fmtDateTime } from '@/lib/dates';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from './lib/notification-api';

/**
 * W5-08 — the in-app notification inbox behind the header bell.
 *
 * The bell existed as a `<button>` with no `onClick`, no badge and no panel,
 * while `GET /notifications` + the two read endpoints had been live the whole
 * time. Every notification the system raised was written to a table nobody
 * could read — an approval waiting on you, a cold-chain breach, a sync
 * conflict, all silent.
 *
 * Polled rather than pushed. The sync engine's socket is for device sync, not
 * user messaging, and hanging notifications off it would couple the two: a
 * device with no credential (every browser today, see `browser.ts`) would then
 * also lose its notifications. A 60s poll is unglamorous and works for
 * everyone.
 */
const POLL_MS = 60_000;

/** Where a notification points, when its payload names a document. Kept as a
 * small explicit map rather than a computed route so an unknown `refType`
 * renders as plain text instead of linking somewhere that does not exist. */
const REF_ROUTES: Record<string, string> = {
  surat_jalan: '/delivery',
  replenishment: '/warehouse',
  purchase_order: '/purchasing',
  purchase_request: '/purchasing',
  payment_verification: '/finance',
  stock_opname: '/outlet',
  waste: '/outlet',
  petty_cash: '/outlet',
  payroll_run: '/hr',
  leave_request: '/hr',
};

function hrefFor(n: AppNotification): string | null {
  const refType = typeof n.payload?.refType === 'string' ? n.payload.refType : null;
  return refType ? (REF_ROUTES[refType] ?? null) : null;
}

export function NotificationBell({ className }: { className?: string }) {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const unread = items.filter((n) => !n.readAt).length;

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const res = await listNotifications();
      setItems(res.rows);
    } catch {
      // A failed poll must never break the shell it lives in — the bell just
      // keeps showing whatever it last knew.
    } finally {
      setLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [user, refresh]);

  // Close on outside click / Escape — same affordances as the profile menu
  // beside it, so the header behaves consistently.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function onOpenItem(n: AppNotification) {
    if (n.readAt) return;
    // Optimistic: the badge must drop the instant it is clicked, and a failed
    // mark-read is recoverable on the next poll.
    setItems((prev) =>
      prev.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)),
    );
    try {
      await markNotificationRead(n.id);
    } catch {
      void refresh();
    }
  }

  async function onMarkAll() {
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    try {
      await markAllNotificationsRead();
    } catch {
      void refresh();
    }
  }

  if (!user) return null;

  return (
    <div ref={panelRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-text-secondary hover:bg-surface-sunken"
        aria-label={t('shell.notifications')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold leading-4 text-white"
            aria-label={t('notifications.unreadCount', { count: unread })}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-sm font-semibold text-text-primary">{t('shell.notifications')}</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={onMarkAll}
                className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
              >
                <CheckCheck className="size-3.5" aria-hidden />
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {!loaded && (
              <p className="px-3 py-6 text-center text-sm text-text-muted">{t('common.loading')}</p>
            )}
            {loaded && items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-text-muted">
                {t('shell.noNotifications')}
              </p>
            )}

            {items.map((n) => {
              const href = hrefFor(n);
              const inner = (
                <div
                  className={cn(
                    'flex flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left last:border-b-0',
                    !n.readAt && 'bg-brand-50/60',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && (
                      <span
                        className="mt-1.5 size-1.5 flex-none rounded-full bg-brand-500"
                        aria-label={t('notifications.unread')}
                      />
                    )}
                    <p className="text-sm font-medium text-text-primary">{n.title}</p>
                  </div>
                  <p className="text-xs text-text-secondary">{n.body}</p>
                  <p className="text-[11px] text-text-muted">{fmtDateTime(n.createdAt)}</p>
                </div>
              );

              return href ? (
                <Link
                  key={n.id}
                  href={href}
                  onClick={() => {
                    void onOpenItem(n);
                    setOpen(false);
                  }}
                  className="block hover:bg-surface-sunken"
                >
                  {inner}
                </Link>
              ) : (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void onOpenItem(n)}
                  className="block w-full hover:bg-surface-sunken"
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
