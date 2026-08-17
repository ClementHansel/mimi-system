'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, Clock, FileText, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { DocBody } from '@/components/docs/DocBody';
import { MANUALS, getManual, tocFor } from '@/content/docs';

/**
 * F-DOCS reader — clear typography, a section outline (in-page nav on
 * screen, `#id` anchors), and a "Download PDF" button that calls
 * `window.print()` against the print stylesheet in `../docs.css`. This is
 * the print-optimised-route approach the ticket asked for instead of a PDF
 * library: no added dependency, the browser does the rendering, and the
 * cover/@page rules below only ever apply inside `@media print`.
 *
 * Full-text search across manuals was left out of this build. Six manuals
 * is genuinely small enough to browse from the index without one, and a
 * real implementation (indexing every section's prose, ranking, highlighting
 * matches) is more than this ticket's budget should spend on a feature that
 * would matter more once there are 30 manuals than at 6 — better to skip it
 * cleanly than ship a slow or half-working search box. Revisit once the
 * manual count grows enough that browsing the index stops being enough.
 */
export default function DocReaderPage() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const params = useParams<{ slug: string }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const manual = slug ? getManual(slug) : undefined;

  const [printedOn, setPrintedOn] = useState('');
  useEffect(() => {
    setPrintedOn(new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }));
  }, []);

  const visible = useMemo(() => MANUALS.filter((m) => can(m.permission)), [can]);
  const idx = manual ? visible.findIndex((m) => m.slug === manual.slug) : -1;
  const prev = idx > 0 ? visible[idx - 1] : null;
  const next = idx >= 0 && idx < visible.length - 1 ? visible[idx + 1] : null;

  if (!manual) {
    return (
      <EmptyState
        icon={FileText}
        title={t('docs.notFoundTitle')}
        description={t('docs.notFoundDescription')}
        size="lg"
        action={<Link href="/docs" className="text-sm font-semibold text-brand-600 hover:underline">{t('docs.backToAll')}</Link>}
      />
    );
  }

  if (!can(manual.permission)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={t('docs.deniedTitle')}
        description={t('docs.deniedDescription')}
        size="lg"
        action={<Link href="/docs" className="text-sm font-semibold text-brand-600 hover:underline">{t('docs.backToAll')}</Link>}
      />
    );
  }

  const toc = tocFor(manual);

  return (
    <>
      {/* Print-only branded cover — hidden on screen, shown via docs.css's @media print rule. */}
      <div className="doc-print-cover" aria-hidden>
        <span className="cover-kicker">{t('docs.printKicker')}</span>
        <div className="cover-rule" />
        <h1 className="cover-title">{manual.title}</h1>
        <p className="cover-audience">{t('docs.printAudience', { audience: manual.audience })}</p>
        <div className="cover-foot">
          <strong>Mimi Chicken OS</strong> — {t('docs.printFootline')}
          {printedOn ? ` · ${t('docs.printedOn', { date: printedOn })}` : ''}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_200px]">
        <article className="min-w-0">
          <header className="doc-header mb-6 border-b border-border pb-5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="brand" size="sm">{manual.audience}</Badge>
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <Clock className="size-3.5" aria-hidden /> {t('docs.minutesRead', { minutes: manual.minutes })}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <FileText className="size-3.5" aria-hidden /> {t('docs.sectionsCount', { count: toc.length })}
              </span>
            </div>
            <h1 className="font-display text-2xl font-bold text-text-primary sm:text-3xl">{manual.title}</h1>
            <div className="docs-print-hide mt-4 flex gap-2">
              <Button variant="primary" size="sm" leftIcon={<Download className="size-4" aria-hidden />} onClick={() => window.print()}>
                {t('docs.downloadPdf')}
              </Button>
              <Link href="/docs">
                <Button variant="outline" size="sm" leftIcon={<ArrowLeft className="size-4" aria-hidden />}>{t('docs.backToAll')}</Button>
              </Link>
            </div>
          </header>

          <div className="doc-body">
            <DocBody sections={manual.sections} />
          </div>

          <nav className="docs-print-hide mt-10 flex justify-between gap-4 border-t border-border pt-5 text-sm">
            {prev ? (
              <Link href={`/docs/${prev.slug}`} className="flex flex-col text-brand-600 hover:underline">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t('docs.prev')}</span>
                ← {prev.title}
              </Link>
            ) : <span />}
            {next ? (
              <Link href={`/docs/${next.slug}`} className="flex flex-col text-right text-brand-600 hover:underline">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t('docs.next')}</span>
                {next.title} →
              </Link>
            ) : <span />}
          </nav>
        </article>

        {toc.length > 0 && (
          <aside className="docs-print-hide hidden lg:block">
            <div className="sticky top-6 flex flex-col gap-1 text-sm">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('docs.onThisPage')}</div>
              {toc.map((entry) => (
                <a
                  key={entry.id}
                  href={`#${entry.id}`}
                  className={`border-l-2 border-border py-1 pl-3 text-text-secondary hover:border-brand-400 hover:text-brand-700 ${entry.level === 3 ? 'pl-5 text-[0.83rem]' : ''}`}
                >
                  {entry.text}
                </a>
              ))}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
