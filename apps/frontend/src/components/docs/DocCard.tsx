import Link from 'next/link';
import { Clock, FileText } from 'lucide-react';
import type { DocManual } from '@/content/docs/types';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/lib/i18n';

export function DocCard({ manual }: { manual: DocManual }) {
  const { t } = useI18n();
  return (
    <Link
      href={`/docs/${manual.slug}`}
      className="group flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4 shadow-xs transition-colors hover:border-brand-300 hover:bg-brand-50"
    >
      <Badge variant="brand" size="sm" className="self-start">
        {manual.audience}
      </Badge>
      <h3 className="font-display text-base font-semibold text-text-primary">{manual.title}</h3>
      <p className="text-sm text-text-muted">{manual.blurb}</p>
      <div className="mt-auto flex items-center gap-3 pt-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3.5" aria-hidden />{' '}
          {t('docs.minutesRead', { minutes: manual.minutes })}
        </span>
        <span className="inline-flex items-center gap-1">
          <FileText className="size-3.5" aria-hidden />{' '}
          {t('docs.sectionsCount', { count: manual.sections.length })}
        </span>
      </div>
    </Link>
  );
}
