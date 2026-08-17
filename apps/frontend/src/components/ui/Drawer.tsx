'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 'bottom' is the natural sheet for mobile (F11/F13); 'right' for desktop side panels. */
  side?: 'right' | 'left' | 'bottom';
  size?: 'sm' | 'md' | 'lg';
}

const SIDE_CLASSES: Record<NonNullable<DrawerProps['side']>, string> = {
  right: 'inset-y-0 right-0 h-full border-l',
  left: 'inset-y-0 left-0 h-full border-r',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl border-t',
};

const SIZE_CLASSES: Record<'right' | 'left', Record<NonNullable<DrawerProps['size']>, string>> = {
  right: { sm: 'w-80', md: 'w-96', lg: 'w-[32rem]' },
  left: { sm: 'w-80', md: 'w-96', lg: 'w-[32rem]' },
};

/** Edge-anchored panel — a side sheet on desktop, a bottom sheet on mobile. Use `Modal` for a centered dialog. */
export function Drawer({ open, onClose, title, children, footer, side = 'right', size = 'md' }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-stone-900/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className={cn(
          'absolute flex flex-col bg-surface-raised shadow-lg',
          SIDE_CLASSES[side],
          side !== 'bottom' && SIZE_CLASSES[side][size],
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border p-4">
          <h2 id="drawer-title" className="font-display text-lg font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex-none rounded p-1 text-text-muted hover:bg-surface-sunken hover:text-text-primary"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border p-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
