import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY MUTATING ENDPOINT SHOULD BE RUN BY SOMETHING BEFORE A CLIENT RUNS IT.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * The defects this project keeps shipping are not subtle. They are endpoints
 * nobody ever called:
 *
 *   * `PUT /suppliers/:id/items/:itemId` returned 500 for every call — an
 *     unqualified column in an ON CONFLICT clause, so the whole supplier price
 *     list was dead. The client found it: "saat klik tambah tidak terjadi apa
 *     apa".
 *   * `POST /notifications/read-all` returned 500 for every call — it wrote on
 *     the request client and never committed, which `RlsCleanupInterceptor`
 *     converts into a loud failure. Found 2026-09-04 by walking this list, not
 *     by a test.
 *
 * Both were one call away from being caught. 241 write endpoints exist; the
 * baseline below records the ones no test so much as mentions, and this suite
 * fails when that set GROWS. It is a ratchet, not an audit: the debt is
 * visible, and new debt cannot be added quietly.
 *
 * ── WHAT "EXERCISED" MEANS HERE, AND WHAT IT DOES NOT ───────────────────────
 * A handler counts as exercised when its name or its route path appears in any
 * spec under `apps/backend` or `e2e/`. That is a HEURISTIC and it is generous:
 * a spec that merely names a path proves nothing about calling it. It is still
 * worth having, because the endpoints it flags are the ones with no plausible
 * coverage at all — and both 500s above sat in exactly that set.
 *
 * Tightening this into real coverage measurement (instrumenting the router and
 * recording hits) is the better answer and a bigger job. Do not read a passing
 * run as "every write endpoint works".
 */

const BACKEND = join(__dirname, '..');
const REPO = join(BACKEND, '..', '..');

interface WriteEndpoint {
  handler: string;
  verb: string;
  path: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function writeEndpoints(): WriteEndpoint[] {
  const found: WriteEndpoint[] = [];
  for (const file of walk(join(BACKEND, 'src'))) {
    if (!file.endsWith('.controller.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const base = /@Controller\('([^']*)'\)/.exec(source)?.[1];
    if (base === undefined) continue;

    for (const m of source.matchAll(
      /@(Post|Put|Patch|Delete)\((?:'([^']*)')?\)[\s\S]{0,400}?\n {2}(?:async )?(\w+)\(/g,
    )) {
      const [, verb, sub = '', handler] = m;
      const path = `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      found.push({ handler: handler!, verb: verb!, path });
    }
  }
  return found;
}

function specCorpus(): string {
  const parts: string[] = [];
  for (const root of [join(BACKEND, 'src'), join(BACKEND, 'test'), join(REPO, 'e2e', 'tests')]) {
    for (const file of walk(root)) {
      if (!/\.(spec|test)\.tsx?$/.test(file)) continue;
      if (file.endsWith('write-endpoint-inventory.spec.ts')) continue;
      parts.push(readFileSync(file, 'utf8'));
    }
  }
  return parts.join('\n');
}

/**
 * Write endpoints no spec mentions, as of 2026-09-04.
 *
 * This is DEBT, recorded so it cannot grow. Shrinking it is the work; every
 * line removed is an endpoint somebody proved runs.
 *
 * ── HAND-WALKED 2026-09-04, STILL UNAUTOMATED ───────────────────────────────
 * Fifteen of these were driven by hand against a running server while the
 * client was testing, to find what they were about to hit. They stay on this
 * list because a manual walk is not a test — nothing re-runs it — but they are
 * marked so the next reader can tell "nobody has ever run this" from "ran once,
 * on this date, and worked":
 *
 *   walked OK   items/categories (POST, PATCH), locations storage-areas (POST,
 *               PATCH, DELETE), products/categories (POST), products/categories
 *               /order (PUT), suppliers items (DELETE), users reset-password,
 *               settings/email (PUT, and re-read on a fresh request to prove
 *               the commit), hr/contracts/sweep-expired, approvals code (POST),
 *               pos shifts close, pos cash-variances approve, pos void-refunds
 *               approve
 *
 * The walk found two defects the client had not reached yet: the void/refund
 * chain collided on its first decision (every seeded multi-step document did),
 * and shift close raises a cash-variance proposal only for a SHORTFALL, never
 * an overage — which is correct per D-19 and worth knowing before someone
 * reports it as a bug.
 */
const KNOWN_UNEXERCISED: ReadonlySet<string> = new Set([
  'POST /approvals/:documentType/:documentId/code',
  'POST /auth/offline-credential/:credentialId/revoke',
  'POST /auth/offline-credential/:credentialId/unlock-code',
  'POST /auth/offline-credential/refresh',
  'POST /delivery/surat-jalan/:id/positions',
  'PATCH /delivery/surat-jalan/drops/:dropId/instructions',
  'POST /hr/contracts/sweep-expired',
  'POST /items/categories',
  'PATCH /items/categories/:id',
  'POST /locations/:id/storage-areas',
  'PATCH /locations/:id/storage-areas/:areaId',
  'DELETE /locations/:id/storage-areas/:areaId',
  'PUT /payroll/employees/:employeeId/components',
  'PATCH /payroll/runs/:id/lines/:lineId',
  'POST /payroll/runs/:id/mark-paid',
  'POST /payroll/runs/:id/recalculate',
  'POST /payroll/runs/:id/send-slips',
  'POST /pos/cash-variances/:id/approve',
  'POST /pos/cash-variances/:id/reject',
  'POST /pos/online-orders',
  'POST /pos/sales',
  'POST /pos/shifts/:id/close',
  'POST /pos/void-refunds/:id/approve',
  'POST /pos/void-refunds/:id/reject',
  'PUT /products/:id/package',
  'DELETE /products/:id/package',
  'POST /products/categories',
  'PATCH /products/categories/:id',
  'DELETE /products/categories/:id',
  'PUT /products/categories/order',
  'PUT /settings/email',
  'POST /settings/email/test',
  'DELETE /suppliers/:id/items/:itemId',
  'POST /users/:id/reset-password',
]);

describe('write-endpoint inventory', () => {
  const endpoints = writeEndpoints();
  const corpus = specCorpus();

  const unexercised = endpoints
    .filter((e) => !corpus.includes(e.handler) && !corpus.includes(e.path))
    .map((e) => `${e.verb.toUpperCase()} ${e.path}`);

  it('found the controllers at all', () => {
    // A refactor that moves or renames controllers would otherwise make this
    // suite pass by finding nothing.
    expect(
      endpoints.length,
      'no write endpoints were discovered — the scanner is broken',
    ).toBeGreaterThan(150);
  });

  it('has no mutating endpoint that is newly untested', () => {
    const added = [...new Set(unexercised)].filter((e) => !KNOWN_UNEXERCISED.has(e)).sort();

    expect(
      added,
      'these write endpoints are not named by any spec. Two endpoints in exactly this ' +
        'state returned 500 for every call and were found by a client:\n  ' +
        added.join('\n  '),
    ).toEqual([]);
  });

  it('reports the size of the debt, and notices when it is paid down', () => {
    const still = [...new Set(unexercised)].filter((e) => KNOWN_UNEXERCISED.has(e));
    const paidOff = [...KNOWN_UNEXERCISED].filter((e) => !unexercised.includes(e)).sort();

    console.log(
      `[write-inventory] ${endpoints.length} write endpoints, ${still.length} still unexercised`,
    );

    // Not a failure — a nudge. Removing a line from the baseline when its
    // endpoint gains a test is what makes the ratchet tighten instead of
    // rusting at its original setting.
    if (paidOff.length > 0) {
      console.log(
        `[write-inventory] now covered — delete these from KNOWN_UNEXERCISED:\n  ${paidOff.join('\n  ')}`,
      );
    }
    expect(still.length).toBeLessThanOrEqual(KNOWN_UNEXERCISED.size);
  });
});
