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
  // An unresolved i18n key rendering as itself — `translate()` returns the key
  // on a miss, which puts `errors.byCode.…` on screen. Silent in production
  // builds, so only a browser assertion catches it.
  /\b(errors|common|purchasing|outlet|finance|hr|pos)\.[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+\b/,
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
