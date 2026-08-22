import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-13 — the approval deep link must land on a route that exists.
 *
 * `ApprovalService.deepLinkFor` builds
 * `${APP_WEB_BASE_URL}/approvals/:documentType/:documentId` and puts it in
 * every `approval_pending` / `approval_decided` notification, including the
 * WhatsApp ones. When the blocker was raised there was no `/approvals` route at
 * all: an approver was told they had work waiting and handed a link that 404s,
 * which is worse than sending no notification.
 *
 * Both halves exist now. This test is what stops them drifting apart again, and
 * it is a filesystem assertion ON PURPOSE — the failure mode is structural (a
 * route folder renamed or moved during a refactor), and no amount of rendering
 * the component proves the URL still resolves. The backend half is pinned in
 * `kernel/approvals/approvals.integration.spec.ts`.
 *
 * If this fails, do not "fix" it by deleting it: either restore the route, or
 * change `deepLinkFor` to match the new one and update the assertion here in
 * the same commit.
 */
describe('B-13 — the approval notification deep link resolves to a real route', () => {
  const appDir = join(process.cwd(), 'src', 'app');

  it('the dynamic detail route exists at exactly the path the backend links to', () => {
    // Segment names matter as much as the shape: Next.js routes on the folder
    // name, so `[docType]` here with `documentType` in the link would still 404.
    const route = join(appDir, 'approvals', '[documentType]', '[documentId]', 'page.tsx');
    expect(existsSync(route)).toBe(true);
  });

  it('the inbox the notification implies also exists', () => {
    // `getPending()` was built, tested, and rendered nowhere — approvers were
    // told they had work and had no queue to open. That was the compounding
    // half of B-13, and it is a separate route from the deep link above.
    expect(existsSync(join(appDir, 'approvals', 'page.tsx'))).toBe(true);
  });
});
