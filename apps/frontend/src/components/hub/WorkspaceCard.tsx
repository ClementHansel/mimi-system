'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

export interface WorkspaceCardProps {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * F-HUB-2 — one of the hub's (at most three) big workspace tiles: an icon
 * tile, a bold title, and a single plain-language sentence about the work
 * done there. Deliberately dumb — `app/page.tsx` decides which workspaces
 * exist, in what order, and where each links (permission-derived from
 * `lib/nav.ts`); this component only renders the one it's given, so it can
 * never itself become a second hand-listed nav surface.
 *
 * `min-h-touch-lg` (56px, `globals.css`'s POS/outlet tablet floor) plus the
 * generous `p-8` padding keeps the whole tile comfortably above the 44px
 * touch-target minimum even on the smallest phone width this renders at.
 */
export function WorkspaceCard({ href, icon: Icon, title, description }: WorkspaceCardProps) {
  return (
    <Link
      href={href}
      className="group flex min-h-touch-lg flex-col items-center gap-4 rounded-2xl border border-border bg-surface-raised p-8 text-center shadow-xs transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="flex size-16 flex-none items-center justify-center rounded-2xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100">
        <Icon className="size-8" aria-hidden />
      </span>
      <span className="font-display text-xl font-bold text-text-primary">{title}</span>
      <span className="text-sm text-text-secondary">{description}</span>
    </Link>
  );
}
