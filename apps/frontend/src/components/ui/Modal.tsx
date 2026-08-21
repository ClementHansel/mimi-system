'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnOverlayClick?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * Centered modal dialog: focus-trapped, Escape-to-close, scroll-locked. Use
 * `Drawer` for edge-anchored panels.
 *
 * WHY `onClose` IS HELD IN A REF. Almost every caller passes an inline arrow
 * (`onClose={() => setOpen(false)}`), which is a new function identity on every
 * render. With `onClose` in the setup effect's dependency array, that made the
 * whole effect tear down and re-run on EVERY parent re-render — including the
 * one caused by typing a character into a field inside the modal. Teardown
 * restored focus to the trigger and setup then moved focus to the dialog's
 * first focusable (the close button), so a reason textarea lost focus after
 * every single keystroke: type one letter, click the box again, type one more.
 * The ref keeps the handler current while the effect stays keyed on `open`
 * alone, so focus is set exactly once per opening.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Kept current without re-running the setup effect below — see the header.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Prefer the first FIELD over the first focusable. In DOM order the close
    // button comes first, so a dialog whose whole point is "type a reason"
    // used to open with focus on the X — the user had to click into the box
    // before typing. Falls back to any focusable for dialogs with no fields.
    const target =
      dialogRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), select, textarea',
      ) ??
      dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])',
      );
    target?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const list = Array.from(focusables);
        const idx = list.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (idx === 0 || idx === -1)) {
          e.preventDefault();
          list[list.length - 1]?.focus();
        } else if (!e.shiftKey && idx === list.length - 1) {
          e.preventDefault();
          list[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-stone-900/50"
        onClick={closeOnOverlayClick ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col rounded-lg bg-surface-raised shadow-lg',
          SIZE_CLASSES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <h2 id="modal-title" className="font-display text-lg font-semibold text-text-primary">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
          </div>
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
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border p-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
