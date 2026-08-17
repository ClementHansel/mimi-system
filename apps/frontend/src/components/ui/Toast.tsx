'use client';

import { create } from 'zustand';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Toast — call `toast(...)` from anywhere (event handlers, catch blocks, even
 * outside React) and mount `<ToastViewport />` ONCE in `AppShell`. State lives
 * in a small module-local zustand store here rather than `src/stores/` —
 * that folder is reserved for the shell-level session/nav/connectivity
 * stores (BUILD-PLAN §5 W1-E row); a toast queue is a UI-primitive concern
 * that travels with the component.
 */

export type ToastVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms before auto-dismiss; 0 disables auto-dismiss. Default 5000. */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'title' | 'variant' | 'duration'>> {
  id: string;
  description?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (item: ToastItem) => void;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (item) => set((s) => ({ toasts: [...s.toasts, item] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let counter = 0;

/** Enqueue a toast. Safe to call from anywhere, including outside React (e.g. `apiFetch` error handlers). */
export function toast(options: ToastOptions): string {
  const id = `toast-${Date.now()}-${counter++}`;
  const item: ToastItem = {
    id,
    title: options.title,
    description: options.description,
    variant: options.variant ?? 'default',
    duration: options.duration ?? 5000,
  };
  useToastStore.getState().push(item);
  if (item.duration > 0) {
    setTimeout(() => useToastStore.getState().dismiss(id), item.duration);
  }
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

const VARIANT_META: Record<ToastVariant, { icon: typeof Info; classes: string }> = {
  default: { icon: Info, classes: 'border-border bg-surface-raised text-text-primary' },
  success: { icon: CheckCircle2, classes: 'border-success-600/30 bg-success-50 text-success-700' },
  warning: { icon: AlertTriangle, classes: 'border-warning-600/30 bg-warning-50 text-warning-700' },
  danger: { icon: XCircle, classes: 'border-danger-600/30 bg-danger-50 text-danger-700' },
  info: { icon: Info, classes: 'border-info-600/30 bg-info-50 text-info-700' },
};

/** Mount once, at the root of the app shell. Renders the live toast queue. */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0"
      role="region"
      aria-live="polite"
      aria-label="Notifikasi"
    >
      {toasts.map((t) => {
        const meta = VARIANT_META[t.variant];
        const Icon = meta.icon;
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border p-3 shadow-md sm:w-96',
              meta.classes,
            )}
          >
            <Icon className="mt-0.5 size-5 flex-none" aria-hidden />
            <div className="flex-1 text-sm">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 opacity-90">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="flex-none rounded p-0.5 opacity-60 hover:opacity-100"
              aria-label="Tutup"
            >
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
