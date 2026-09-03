import { type Page } from '@playwright/test';
import { PERMISSION_KEYS } from '@mimi/shared';

/**
 * The app's REAL permission keys — `auth.pin.set`, `purchasing.po.create`,
 * `delivery.sj.create` — imported rather than guessed at.
 *
 * They are shaped exactly like an unresolved i18n key (dotted, lowercase) and
 * the AUDIT LOG renders them on purpose: "who did what" is the whole point of
 * that screen. Once the i18n rule below was widened to all 47 namespaces it
 * began matching them, and `/admin -> Jejak Audit` failed CI and blocked a
 * production deploy over a screen that was working perfectly.
 *
 * Comparing against the real list is exact and self-maintaining: a new
 * permission key stops being a false positive the moment it joins the matrix,
 * and a genuine unresolved key is still caught because it is not in it.
 */
let permissionKeyCache: ReadonlySet<string> | null = null;

/**
 * Built LAZILY, and loudly.
 *
 * At module-init the imported `PERMISSION_KEYS` was `undefined` here — an
 * ESM/CJS interop ordering quirk against the built package — and
 * `new Set(undefined)` returns an EMPTY SET rather than throwing. The excuse
 * below then silently never applied, so a working audit screen kept failing
 * while every condition looked correct in isolation. That cost an hour of
 * bisecting a guard rather than a bug.
 *
 * Resolving on first use dodges the ordering, and the emptiness check turns the
 * silent version of this failure into a sentence that names it.
 */
export function permissionKeys(): ReadonlySet<string> {
  if (permissionKeyCache) return permissionKeyCache;
  const keys = (PERMISSION_KEYS ?? []) as readonly string[];
  if (keys.length === 0) {
    throw new Error(
      'PERMISSION_KEYS from @mimi/shared is empty — the audit screen will be reported as ' +
        'leaking technical text. Check that packages/shared is built.',
    );
  }
  permissionKeyCache = new Set(keys);
  return permissionKeyCache;
}

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
  /\b(shell|nav|auth|role|hub|docs|pos|common|errors|validation|lineImport|exportData|deliveryAssign|importData|chatInternal|table|photo|signature|fileUpload|dateRange|offline|sync|approvalTimeline|permissionGate|approvals|approvalsInbox|approvalCode|approvalDetail|emptyState|status|placeholder|setPin|finance|chat|purchasing|admin|outlet|warehouse|delivery|hr|me|notifications|print|driver|assets|dashboard|topology|doc|brand|voucher)\.[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9._]+/,
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
  const text = withoutPermissionKeys(await page.locator('body').innerText());
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

  for (const phrase of ['Gagal memuat data', 'Gagal memuat']) {
    const count = await page.getByText(phrase, { exact: false }).count();
    if (count > 0) {
      throw new Error(
        `"${phrase}" is on screen${context ? ` (${context})` : ''} — the surface failed to load.`,
      );
    }
  }

  // "Terjadi kesalahan" IS NOT NECESSARILY A LOAD FAILURE — it is
  // `errors.generic`, the app's sanctioned last resort, and it can legitimately
  // reach the screen as a toast after an action. Reporting it as "the surface
  // failed to load" sent me looking for a broken fetch when the real finding
  // was a form answering an empty submit with the last-resort sentence while
  // the server had already named the field.
  //
  // Still flagged, because it is a bad answer either way: whoever sees it has
  // been told that something went wrong and nothing about what to do. The
  // diagnosis just has to be honest about which of the two it is.
  if ((await page.getByText('Terjadi kesalahan', { exact: false }).count()) > 0) {
    throw new Error(
      `THE LAST-RESORT ERROR IS ON SCREEN${context ? ` (${context})` : ''} — ` +
        `"Terjadi kesalahan". Either the surface failed to load, or an action was ` +
        `refused and the code discarded the server's explanation instead of ` +
        `passing it through \`errMsg()\`. Check the network tab: a response ` +
        `carrying a \`code\` and \`details.field\` can say which field is wrong.`,
    );
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

/**
 * Blanks out the app's REAL permission keys before the vocabulary check runs.
 *
 * They are shaped exactly like an unresolved i18n key — dotted and lowercase —
 * and the AUDIT LOG renders them on purpose: "who did what" is the whole point
 * of that screen. Once the i18n rule was widened to all 47 namespaces it began
 * matching `auth.pin.set` and `purchasing.po.create`, and `/admin → Jejak
 * Audit` failed CI and blocked a production deploy over a screen that was
 * working perfectly.
 *
 * SUBTRACTING them from the text beats deciding per line whether a line is
 * "really" a leak. The first attempt did the latter — count the matching rules,
 * extract the dotted tokens, check them all against the key set — and every
 * input to it verified correct in isolation while it still returned false. An
 * hour went into bisecting a guard rather than a bug. This version has one
 * moving part and is obvious: a string that IS a permission key is not a leak,
 * so remove it and ask the question again.
 *
 * Exact, and self-maintaining: a new key stops being a false positive the
 * moment it joins the matrix, and a genuine unresolved key still matches
 * because it is not in the list.
 */
function withoutPermissionKeys(text: string): string {
  const keys = permissionKeys();
  let scrubbed = text;
  for (const key of keys) {
    if (scrubbed.includes(key)) scrubbed = scrubbed.split(key).join('«permission»');
  }
  return scrubbed;
}
