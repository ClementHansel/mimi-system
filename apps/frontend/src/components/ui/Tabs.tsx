'use client';

import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TabsCtx {
  value: string;
  setValue: (v: string) => void;
  idPrefix: string;
}

const Ctx = createContext<TabsCtx | null>(null);

function useTabsCtx(component: string): TabsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs>`);
  return ctx;
}

export interface TabsProps {
  /** Uncontrolled initial tab. Ignored if `value` is provided. */
  defaultValue?: string;
  /** Controlled selected tab. */
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({ defaultValue, value, onValueChange, children, className }: TabsProps) {
  const idPrefix = useId();
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = value ?? internal;
  const setValue = (v: string) => {
    if (value === undefined) setInternal(v);
    onValueChange?.(v);
  };
  return (
    <Ctx.Provider value={{ value: current, setValue, idPrefix }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 border-b border-border', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  const ctx = useTabsCtx('TabsTrigger');
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.idPrefix}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.idPrefix}-panel-${value}`}
      disabled={disabled}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
        selected ? 'border-brand-500 text-brand-600' : 'border-transparent text-text-muted hover:text-text-primary',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const ctx = useTabsCtx('TabsContent');
  if (ctx.value !== value) return null;
  return (
    <div role="tabpanel" id={`${ctx.idPrefix}-panel-${value}`} aria-labelledby={`${ctx.idPrefix}-tab-${value}`} className={cn('pt-4', className)}>
      {children}
    </div>
  );
}
