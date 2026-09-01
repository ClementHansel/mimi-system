import { type Page } from '@playwright/test';

/**
 * "Is the user being shown the machine's words?" — as an assertion.
 *
 * On 2026-08-31 the owner hit a toast reading
 * `duplicate key value violates unique constraint "suppliers_code_key"`.
 * That was one symptom of a general hole: `ApiErrorShape.message` is defined
 * as DEVELOPER text (CONTRACTS §0), and a dozen screens printed it straight
 * into the UI, so ANY unhandled server error could surface SQL, a table name,
 * or a stack frame. The backend now sanitizes what it sends
 * (`common/filters/pg-error.util.ts`) and the frontend resolves copy from the
 * error CODE (`lib/api-error.ts`) — this is the outside-in check that both
 * halves stay honest on a real page.
 *
 * It is deliberately a VOCABULARY check rather than a list of known-bad
 * strings: the next leak will be a different constraint on a different form,
 * and nobody will remember to add it here. Every term below is one that
 * cannot legitimately appear in Bahasa Indonesia UI copy.
 */
export const TECHNICAL_VOCABULARY: readonly RegExp[] = [
  // Postgres error text
  /duplicate key value/i,
  /violates \w+ constraint/i,
  /unique constraint/i,
  /foreign key constraint/i,
  /null value in column/i,
  /invalid input syntax/i,
  /relation "[^"]+" does not exist/i,
  /column "[^"]+" does not exist/i,
  /permission denied for (table|relation)/i,
  /there is no parameter/i,
  /SQLSTATE/i,
  // Raw identifiers that only exist in the schema or the wire format
  /\b\w+_key"/,
  /\bERR_[A-Z_]{3,}\b/,
  // A BARE UUID ON SCREEN. Always a bug: either an internal key that escaped,
  // or a human label that failed to resolve and fell back to the id. Both were
  // true of Gudang's approval queue, which printed
  // `2e75a93f-40f6-45a3-a177-bf20ff4e7c9c` under "Diminta Oleh" because the
  // requester's name is not readable by that role — found 2026-09-01 by eye,
  // and NOT caught by this guard until this line existed.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  // An unresolved i18n key rendering as itself — `translate()` returns the key
  // on a miss, which puts `errors.byCode.…` on screen. Silent in production
  // builds, so only a browser assertion catches it.
  // EVERY namespace in `lib/i18n/id.ts`, not the seven this started with. A
  // dialog leaks whatever prefix its own copy lives under, and the narrow list
  // would have missed `admin.`, `warehouse.`, `voucher.`, `assets.`, `doc.`
  // and the rest — which is most of the app's forms. Kept as an explicit
  // alternation rather than a generic `\w+\.\w+\.\w+` so ordinary prose that
  // happens to contain two dots does not trip the guard.
  /\b(shell|nav|auth|role|hub|docs|pos|common|errors|validation|lineImport|exportData|deliveryAssign|importData|chatInternal|table|photo|signature|fileUpload|dateRange|offline|sync|approvalTimeline|permissionGate|approvals|approvalsInbox|approvalCode|approvalDetail|emptyState|status|placeholder|setPin|finance|chat|purchasing|admin|outlet|warehouse|delivery|hr|me|notifications|print|driver|assets|dashboard|topology|doc|brand|voucher)\.[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+\b/,
  // Framework/stack noise
  /Unhandled Runtime Error/i,
  /TypeError:/,
  /at \w+ \(.*\.tsx?:\d+/,
  // Untranslated server fallbacks
  /Request failed \(\d+\)/i,
  /Internal server error/i,
];

/**
 * Fails if the page's visible text contains any technical vocabulary.
 *
 * Reads `innerText`, not the HTML — a term inside a `class` attribute or a
 * `data-*` hook is not something a user reads, and matching those would make
 * the check noisy enough to be switched off.
 */
export async function assertNoTechnicalError(page: Page, context?: string): Promise<void> {
  const text = await page.locator('body').innerText();
  const hits = TECHNICAL_VOCABULARY.filter((pattern) => pattern.test(text));
  if (hits.length === 0) return;

  // Quote the offending line, not the whole page: a 200-line dump in the
  // failure output is how a real finding gets skimmed past.
  const lines = text.split('\n').filter((line) => hits.some((h) => h.test(line)));
  throw new Error(
    `Technical text on screen${context ? ` (${context})` : ''} — users must never read this:\n` +
      lines.map((l) => `  › ${l.trim()}`).join('\n') +
      `\n\nMatched: ${hits.map(String).join(', ')}`,
  );
}

/**
 * The other half of "is this screen actually working": the app's own error
 * empty-states. `Gagal memuat data` is what a 500 from a list endpoint looks
 * like to a user — the supplier-search bug showed exactly this and nothing
 * else, so a sweep that only checked for technical words would have missed it.
 */
export async function assertNoLoadFailure(page: Page, context?: string): Promise<void> {
  // A CLIENT-SIDE CRASH FIRST, because it is the worst outcome and the one that
  // reports itself least clearly. Next.js replaces the whole page with
  // "Application error: a client-side exception has occurred", which contains
  // none of the app's own error copy — so the tab sweep that found the Sales
  // tab crashing on production (2026-09-01) failed with a locator TIMEOUT and
  // said nothing about a crash. Naming it turns a confusing failure into an
  // obvious one.
  for (const phrase of ['Application error', 'client-side exception', 'Unhandled Runtime Error']) {
    if ((await page.getByText(phrase, { exact: false }).count()) > 0) {
      throw new Error(
        `THE PAGE CRASHED${context ? ` (${context})` : ''} — "${phrase}". ` +
          `A client-side exception replaced the whole surface; check the browser console ` +
          `and run the same step against a dev build for the real stack trace.`,
      );
    }
  }

  for (const phrase of ['Gagal memuat data', 'Gagal memuat', 'Terjadi kesalahan']) {
    const count = await page.getByText(phrase, { exact: false }).count();
    if (count > 0) {
      throw new Error(
        `"${phrase}" is on screen${context ? ` (${context})` : ''} — the surface failed to load.`,
      );
    }
  }
}

/**
 * Console errors, collected for the duration of a test.
 *
 * A React render crash inside an error boundary can leave a plausible-looking
 * page behind, so a spec that only asserts on visible text can pass over one.
 * The filters are for noise a browser emits regardless of app health.
 */
export function collectConsoleErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  const ignorable = [
    /favicon/i,
    /Download the React DevTools/i,
    /\[Fast Refresh\]/i,
    // Service-worker registration is asserted by its own spec and is
    // legitimately unavailable on an insecure origin.
    /ServiceWorker/i,
    // DEV-SERVER PLUMBING, not the app. Next.js opens an HMR WebSocket that
    // does not exist in a production build, and a long run can have the
    // browser suspend network IO under load — which surfaced as
    // `ERR_NETWORK_IO_SUSPENDED` on `/finance` in the first full-suite run and
    // failed a page that was rendering perfectly.
    //
    // This list is the one place a real failure could be hidden, so it is
    // scoped to sockets and URLs the APP never opens. Do NOT add app-origin
    // errors here to make a spec pass — that converts this whole sweep into
    // decoration.
    /_next\/webpack-hmr/i,
    /ERR_NETWORK_IO_SUSPENDED/i,
    /webpack\.hot-update/i,
  ];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignorable.some((p) => p.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return { errors };
}

/**
 * Failed API calls, WITH their URLs — what the console alone cannot tell you.
 *
 * A browser logs `Failed to load resource: the server responded with a status
 * of 403` and nothing about which resource, so a console-only assertion reports
 * that something is broken without saying what. That is a bug report nobody can
 * act on. This listens to responses instead and records `403 /api/pos/shifts`.
 *
 * Why it matters for role testing: a screen that fires requests the signed-in
 * role is not allowed to make is a real defect even when the page still
 * renders — the UI is not gating its fetches by permission, so every one of
 * those roles pays a round trip to be told no, and any data behind them is
 * silently missing rather than explained.
 */
export function collectApiFailures(page: Page): { failures: string[] } {
  const failures: string[] = [];
  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    if (res.status() < 400) return;
    // Strip the origin so failures read as routes, and collapse ids so the
    // same endpoint does not appear five times with five uuids.
    const path = new URL(url).pathname.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '/:id',
    );
    const entry = `${res.status()} ${res.request().method()} ${path}`;
    if (!failures.includes(entry)) failures.push(entry);
  });
  return { failures };
}
