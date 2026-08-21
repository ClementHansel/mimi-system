'use client';

import { useI18n } from '@/lib/i18n';
import { parseJournalDescription } from './lib/journal-description';

/**
 * Renders a journal entry's `description` as a sentence instead of an enum
 * name plus a UUID — see `lib/journal-description.ts` for the why and the
 * parsing rules.
 *
 * Two variants of the same data: `variant="row"` is the ledger cell (label
 * only, technical detail in the tooltip, so a page of entries is scannable),
 * `variant="detail"` is the drawer, where the source document's id is the
 * whole point and is shown in full.
 */
export function JournalDescription({
  description,
  variant = 'row',
}: {
  description: string;
  variant?: 'row' | 'detail';
}) {
  const { t } = useI18n();
  const parts = parseJournalDescription(description);

  // Human-written text passes through verbatim: never re-word what a person
  // typed into the reason box.
  if (parts.eventKey === null) {
    return <span>{parts.text ?? parts.raw}</span>;
  }

  const eventLabel =
    parts.eventKey === 'reversal'
      ? t('finance.journal.event.reversal', { entry: parts.refId ?? '—' })
      : t(`finance.journal.event.${parts.eventKey}`);
  const refLabel = parts.refKey ? t(`finance.journal.ref.${parts.refKey}`) : null;
  const note = parts.eventKey === 'reversal' ? parts.text : null;

  if (variant === 'detail') {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-text-primary">{eventLabel}</span>
        {note && <span className="text-sm text-text-secondary">{note}</span>}
        {(refLabel || parts.refId || parts.rawToken) && (
          <span className="text-xs text-text-muted">
            {[refLabel, parts.rawToken].filter(Boolean).join(' · ')}
            {parts.refId && (
              <>
                {refLabel || parts.rawToken ? ' · ' : ''}
                <span className="font-mono">{parts.refId}</span>
              </>
            )}
          </span>
        )}
      </div>
    );
  }

  return (
    // The raw string stays reachable on hover — an accountant tracing one
    // `usage_day` still needs it; they just should not have to read it to
    // scan the ledger.
    <span title={parts.raw}>
      {eventLabel}
      {note && <span className="text-text-secondary"> — {note}</span>}
      {(refLabel || parts.rawToken) && (
        <span className="text-text-muted">
          {' · '}
          {[refLabel, parts.rawToken].filter(Boolean).join(' ')}
        </span>
      )}
    </span>
  );
}
