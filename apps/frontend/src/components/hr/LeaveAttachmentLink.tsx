'use client';

import { useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { resolveAttachmentUrl } from '@/lib/attachment-url';

/**
 * The link to a leave request's supporting document.
 *
 * The API returns an attachment ID, not a URL, so this presigns it through
 * `resolveAttachmentUrl` — the shared, per-id-cached helper. A table of
 * pending leave requests can hold many rows, and the cache is what keeps that
 * from becoming one presign round trip per row per render.
 *
 * THREE STATES, deliberately distinguished, because collapsing them is how the
 * finance evidence bugs stayed invisible for so long:
 *
 *   no id            — there is genuinely no document. Renders an em dash, the
 *                      same "nothing here" the other columns use.
 *   id, not resolved — either still in flight, or the presign failed
 *                      (`resolveAttachmentUrl` returns null rather than
 *                      throwing). Renders the label WITHOUT a link, so an
 *                      approver can see that a document exists even when it
 *                      cannot be opened. Showing an em dash here would state
 *                      the opposite of the truth.
 *   resolved         — a real link.
 */
export function LeaveAttachmentLink({ attachmentId }: { attachmentId: string | null }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (!attachmentId) return;
    void resolveAttachmentUrl(attachmentId).then((resolved) => {
      // Guard the row being recycled onto another leave request mid-presign:
      // without it, one employee's document can surface under another's name.
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  if (!attachmentId) return <span className="text-text-muted">—</span>;

  const label = t('hr.leaves.viewAttachment');
  if (!url) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-text-muted">
        <Paperclip className="size-3.5" aria-hidden />
        {label}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
    >
      <Paperclip className="size-3.5" aria-hidden />
      {label}
    </a>
  );
}
