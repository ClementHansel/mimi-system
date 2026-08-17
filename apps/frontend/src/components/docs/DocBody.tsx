import type { DocBlock, DocSection } from '@/content/docs/types';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Turns a manual's `DocSection[]` (plain data, see `content/docs/types.ts`)
 * into markup. This is the ONE place manual content becomes JSX — every
 * manual is data, so a new manual or an edited paragraph never touches this
 * file. Deliberately not a markdown renderer: `formatInline` below is two
 * regex passes (bold + code), not a parser, so there's no dependency and no
 * injection surface for the small, author-controlled grammar manuals use.
 */

function formatInline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function Inline({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: formatInline(text) }} />;
}

const calloutTone: Record<'rule' | 'note' | 'warning', string> = {
  rule: 'border-danger-600/30 bg-danger-50 text-danger-700',
  warning: 'border-warning-600/30 bg-warning-50 text-warning-700',
  note: 'border-info-600/30 bg-info-50 text-info-700',
};

const calloutIcon: Record<'rule' | 'note' | 'warning', typeof Info> = {
  rule: ShieldAlert,
  warning: AlertTriangle,
  note: Info,
};

function Block({ block }: { block: DocBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p className="text-[0.95rem] leading-relaxed text-text-secondary">
          <Inline text={block.text} />
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol className="list-decimal space-y-1.5 pl-5 text-[0.95rem] leading-relaxed text-text-secondary marker:font-semibold marker:text-brand-500">
          {block.items.map((item, i) => (
            <li key={i}><Inline text={item} /></li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 text-[0.95rem] leading-relaxed text-text-secondary marker:text-brand-500">
          {block.items.map((item, i) => (
            <li key={i}><Inline text={item} /></li>
          ))}
        </ul>
      );
    case 'steps':
      return (
        <ol className="space-y-2">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-[0.95rem] leading-relaxed text-text-secondary">
              <span className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                {i + 1}
              </span>
              <span className="pt-0.5"><Inline text={item} /></span>
            </li>
          ))}
        </ol>
      );
    case 'callout': {
      const Icon = calloutIcon[block.kind];
      return (
        <div className={cn('flex gap-2.5 rounded-lg border p-3.5 text-sm leading-relaxed', calloutTone[block.kind])}>
          <Icon className="mt-0.5 size-4 flex-none" aria-hidden />
          <p><Inline text={block.text} /></p>
        </div>
      );
    }
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr className="bg-stone-100">
                {block.headers.map((h, i) => (
                  <th key={i} className="border-b border-border px-3 py-2 text-left font-semibold text-text-primary">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className={i % 2 === 1 ? 'bg-surface-sunken/50' : undefined}>
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-border px-3 py-2 align-top text-text-secondary">
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function DocSectionView({ section }: { section: DocSection }) {
  const HeadingTag = section.level === 3 ? 'h3' : 'h2';
  return (
    <section id={section.id} className="scroll-mt-20">
      <HeadingTag
        className={cn(
          'font-display font-semibold text-text-primary',
          section.level === 3 ? 'mt-6 mb-2 text-lg' : 'mt-8 mb-3 border-b border-border pb-2 text-xl',
        )}
      >
        {section.heading}
      </HeadingTag>
      <div className="flex flex-col gap-3">
        {section.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </section>
  );
}

export function DocBody({ sections }: { sections: DocSection[] }) {
  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <DocSectionView key={section.id} section={section} />
      ))}
    </div>
  );
}
