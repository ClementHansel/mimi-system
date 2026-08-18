'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * An anchor styled as a touch-sized button, for launching the phone's map app.
 *
 * Why not `components/ui/Button`: that component renders a `<button>` and has
 * no polymorphic `as`/`href`, and it belongs to the design system (W1-E) — this
 * one screen's need is not a good reason to widen a component every surface
 * depends on. It also genuinely has to be a real `<a href>`: map deep links are
 * far more reliable from a plain anchor than from a scripted
 * `window.open`, which mobile browsers may treat as a popup and block outright.
 *
 * The classes deliberately mirror `Button`'s `touch-lg` sizing and
 * secondary/outline variants so the driver sees one consistent control size on
 * a screen they use one-handed. If `Button` ever gains an `as` prop, this
 * component should be deleted in favour of it.
 */
export function NavigateLink({
  href,
  variant = 'secondary',
  fullWidth = false,
  leftIcon,
  className,
  children,
}: {
  href: string;
  variant?: 'secondary' | 'outline';
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      // Opening in a new context keeps the PWA mounted behind the map app. A
      // driver navigated away in-place would lose any offline-queued actions
      // held in memory, which on a bad-signal route is the whole day's work.
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium',
        'transition-colors h-touch-lg px-6 text-lg gap-2.5 font-semibold',
        variant === 'secondary'
          ? 'bg-stone-100 text-stone-900 hover:bg-stone-200 active:bg-stone-300'
          : 'border border-border-strong bg-surface-raised text-text-primary hover:bg-stone-50',
        fullWidth && 'w-full',
        className,
      )}
    >
      {leftIcon}
      {children}
    </a>
  );
}
