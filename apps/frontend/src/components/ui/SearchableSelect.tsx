'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, Search, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Second line — a code, a city, a supplier's phone. Also searched. */
  hint?: string;
  disabled?: boolean;
}

export interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  label?: string;
  placeholder?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  /** Below this many options a plain list is friendlier than a search box. */
  searchThreshold?: number;
  wrapperClassName?: string;
  className?: string;
}

/**
 * A select for lists a native `<select>` handles badly.
 *
 * The trigger was 20+ outlets in the "Permintaan Pembelian Baru" modal: the
 * native dropdown opened as a list taller than the modal, spilling over the
 * form's other fields and off the bottom of the screen, with no way to do the
 * one thing anybody wants there — type "banjar" and pick. Every long list in
 * this app has the same shape (locations, items, suppliers, accounts), so this
 * is a component rather than a fix in one modal.
 *
 * Deliberate choices:
 *
 *  - The listbox is height-capped and scrolls INSIDE itself, so the popup can
 *    never be taller than the viewport regardless of list length.
 *  - The search box appears only past `searchThreshold` options — for a
 *    four-option status filter it would be furniture.
 *  - `hint` is searched as well as shown, so an outlet is findable by city and
 *    an item by code, not only by the words in its name.
 *  - Keyboard: ↑/↓ move, Enter picks, Escape closes, and typing filters. The
 *    button keeps `aria-expanded`/`aria-controls` and the list uses real
 *    `role="option"` semantics, so this stays operable without a mouse — a
 *    warehouse tablet is used with one hand and a physical keyboard both.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  error,
  hint,
  required,
  disabled,
  searchThreshold = 8,
  wrapperClassName,
  className,
}: SearchableSelectProps) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const showSearch = options.length >= searchThreshold;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);

  // Close on outside click. Pointerdown, not click: a click that starts inside
  // and ends outside (a drag on the scrollbar) must not close the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open, showSearch]);

  function pick(optionValue: string) {
    onValueChange(optionValue);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = filtered[activeIndex];
      if (option && !option.disabled) pick(option.value);
    }
  }

  return (
    <div className={cn('relative flex flex-col gap-1.5', wrapperClassName)} ref={rootRef}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}

      <div className="relative">
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onKeyDown}
          className={cn(
            'flex min-h-touch w-full items-center justify-between gap-2 rounded-md border bg-surface-raised px-3 py-2 text-left text-sm',
            'transition-colors focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error ? 'border-danger-600' : 'border-border-strong',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-text-muted')}>
            {selected?.label ?? placeholder ?? t('common.select')}
          </span>
          <ChevronDown className="size-4 flex-none text-text-muted" aria-hidden />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg">
            {showSearch && (
              <div className="flex items-center gap-2 border-b border-border px-2.5">
                <Search className="size-4 flex-none text-text-muted" aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={t('common.searchPlaceholder')}
                  className="min-h-touch w-full bg-transparent py-2 text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                    aria-label={t('common.clear')}
                    className="flex-none rounded p-1 text-text-muted hover:bg-surface-sunken hover:text-text-primary"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Capped and self-scrolling: the popup cannot outgrow the screen,
                however many outlets, items or suppliers exist. */}
            <ul
              id={`${id}-listbox`}
              role="listbox"
              className="max-h-64 overflow-y-auto overscroll-contain py-1"
            >
              {placeholder && (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === ''}
                    onClick={() => pick('')}
                    className="flex min-h-touch w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-text-muted hover:bg-surface-sunken"
                  >
                    {placeholder}
                    {value === '' && <Check className="size-4 flex-none text-brand-600" />}
                  </button>
                </li>
              )}

              {filtered.map((option, idx) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => pick(option.value)}
                    className={cn(
                      'flex min-h-touch w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                      'disabled:cursor-not-allowed disabled:text-text-muted',
                      idx === activeIndex ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                      option.value === value ? 'font-medium text-brand-700' : 'text-text-primary',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{option.label}</span>
                      {option.hint && (
                        <span className="block truncate text-xs text-text-muted">
                          {option.hint}
                        </span>
                      )}
                    </span>
                    {option.value === value && (
                      <Check className="size-4 flex-none text-brand-600" aria-hidden />
                    )}
                  </button>
                </li>
              ))}

              {filtered.length === 0 && (
                <li className="px-3 py-3 text-sm text-text-muted">{t('common.noResults')}</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {error ? (
        <p className="text-sm text-danger-600">{error}</p>
      ) : hint ? (
        <p className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
