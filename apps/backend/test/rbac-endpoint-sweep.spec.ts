/**
 * W6-03 — RBAC endpoint sweep.
 *
 * `PermissionsGuard` is global, but its own doc states the consequence
 * plainly: "Routes without `@RequirePermission()` are unaffected (open to any
 * authenticated caller)." So a forgotten decorator is not a loud failure — it
 * is a silently unguarded endpoint that any logged-in kasir can call.
 *
 * `role-journeys.spec.ts` (e2e) covers the NAV level: what each role can see.
 * This covers the level that actually matters, the server, and it covers it
 * exhaustively rather than by sampling: every route Nest actually registers
 * is enumerated from the compiled `AppModule` — the same graph `main.ts`
 * builds — so an endpoint cannot escape by living in a module nobody wrote a
 * spec for.
 *
 * What this does NOT do: assert which key each route carries. `PermissionKey`
 * is a closed union, so a typo is already a compile error at the call site,
 * and pinning every route to a specific key here would just restate the
 * controllers in a second place that has to be updated in lockstep. The
 * question worth asking automatically is "is anything unguarded", and that is
 * the question this asks.
 */
import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { REQUIRE_PERMISSION_KEY } from '../src/common/decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';

const hasDb = Boolean(process.env.DATABASE_URL);

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'] as const;

interface Route {
  controller: string;
  handler: string;
  method: string;
  path: string;
  permissions: string[];
  isPublic: boolean;
}

/**
 * Endpoints that are deliberately not permission-gated, each with the reason
 * it is safe. Anything NOT on this list that lacks `@RequirePermission` fails
 * the test — so adding an unguarded route forces a deliberate entry here
 * rather than passing unnoticed.
 */
/**
 * Public routes that WRITE. Each entry names what authenticates the caller in
 * place of a session — a public write with no such mechanism is a hole anyone
 * on the internet can reach.
 */
const ALLOWED_PUBLIC_MUTATIONS: Record<string, string> = {
  'AuthController.login': 'issues the session; the credentials ARE the authentication',
  'AuthController.refresh': 'authenticated by the refresh token in the body',
  'AuthController.logout': 'ends the caller’s own session; nothing else is reachable',
  // Device/node onboarding and sync. All verified as genuinely authenticated
  // when this assertion was added — they were simply never recorded, which is
  // precisely what it exists to prevent.
  'DevicesController.register':
    'pairing-token authenticated (CONTRACTS §4.21); no session exists yet',
  'DevicesController.heartbeat': '`DeviceTokenGuard` — the device credential is the authentication',
  'NodesController.register': 'pairing-token authenticated (CONTRACTS §4.22)',
  'SyncHttpController.hello': '`DeviceAuthGuard` — device credential, not a user session',
  'SyncHttpController.bootstrap': '`DeviceAuthGuard`',
  'SyncHttpController.push': '`DeviceAuthGuard`',
  'ChatInboundController.receive':
    'n8n WhatsApp webhook — authenticated by the `x-webhook-secret` shared secret, ' +
    'which the handler compares BEFORE any write and which refuses every request ' +
    'when `N8N_WEBHOOK_SECRET` is unset (fails closed, never open)',
};

const ALLOWED_UNGUARDED: Record<string, string> = {
  // Authentication itself cannot require a permission — there is no session yet.
  'AuthController.login': '@Public — issues the session',
  'AuthController.refresh': '@Public — rotates tokens, authenticated by the refresh token itself',
  'AuthController.logout': 'ends the caller’s own session; holding a permission is not meaningful',
  'AuthController.me': 'returns the caller’s own identity — the JWT is the authorization',
  'AuthController.setPin': 'sets the caller’s OWN pin; scoped to `req.user.sub`',
  // Liveness/readiness for the container orchestrator.
  'HealthController.check': '@Public — probe',
  'HealthController.live': '@Public — probe',
  'HealthController.ready': '@Public — probe',
  // The sync transport authenticates with a DEVICE credential, not a user
  // permission (SYNC-PROTOCOL §4.1) — see `sync/v1` guards.
  'SyncController.health': '@Public — protocol handshake, no data',

  // CONTRACTS §4.0 marks both approval reads "(any; filtered to caller's
  // role+locations)" — `ApprovalService` scopes the rows by role-eligibility
  // and location instead of a permission key. The controller says so itself.
  'ApprovalsController.pending': 'CONTRACTS §4.0 — any caller, service-scoped',
  'ApprovalsController.detail': 'CONTRACTS §4.0 — any caller, service-scoped',

  // `attachments` carries no RLS by design (migration 009 §1.14 "NONE"
  // group); `StorageService.assertEntityScope` IS the enforcement, and it
  // runs on this path. NOTE its documented gap: an attachment with no
  // `location_id` is readable by anyone authenticated.
  'StorageController.getUrl': 'scope-enforced in StorageService.assertEntityScope',

  // ⚠ KNOWN GAP, not a clearance — see blocker B-15 in PROGRESS.md.
  // This takes an ARBITRARY `userId`, never reads `req.user`, runs under
  // `withSystemContext` (bypassing RLS) and returns a signed `pin_verified`
  // token. Any authenticated caller can therefore test PIN guesses against
  // any other user, unthrottled. It is allowlisted only so this sweep can
  // guard every OTHER route; the mitigation is a product decision (a naive
  // per-target lockout would let anyone disable a supervisor mid-shift).
  'AuthController.verifyPin': 'KNOWN GAP — see B-15; allowlisted, not accepted',
};

let app: INestApplication | undefined;
let routes: Route[] = [];

beforeAll(async () => {
  if (!hasDb) return;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const controllers = (moduleRef as unknown as { container: any }).container.getModules().values();

  const seen = new Set<string>();
  for (const mod of controllers) {
    for (const wrapper of mod.controllers.values()) {
      const instance = wrapper.instance;
      if (!instance) continue;
      const ctor = instance.constructor;
      const basePath = Reflect.getMetadata(PATH_METADATA, ctor) ?? '';

      for (const handler of Object.getOwnPropertyNames(Object.getPrototypeOf(instance))) {
        if (handler === 'constructor') continue;
        const fn = Object.getPrototypeOf(instance)[handler];
        if (typeof fn !== 'function') continue;
        const methodIdx = Reflect.getMetadata(METHOD_METADATA, fn);
        if (methodIdx === undefined) continue; // not a route handler

        const key = `${ctor.name}.${handler}`;
        if (seen.has(key)) continue;
        seen.add(key);

        routes.push({
          controller: ctor.name,
          handler,
          method: HTTP_METHODS[methodIdx] ?? String(methodIdx),
          path: `/${basePath}/${Reflect.getMetadata(PATH_METADATA, fn) ?? ''}`.replace(/\/+/g, '/'),
          permissions:
            Reflect.getMetadata(REQUIRE_PERMISSION_KEY, fn) ??
            Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ctor) ??
            [],
          isPublic:
            Reflect.getMetadata(IS_PUBLIC_KEY, fn) ??
            Reflect.getMetadata(IS_PUBLIC_KEY, ctor) ??
            false,
        });
      }
    }
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe.skipIf(!hasDb)('W6-03 — every registered route is permission-gated', () => {
  it('discovers a realistic number of routes (the sweep is actually sweeping)', () => {
    // Guards the sweep itself: if reflection silently found nothing, every
    // other assertion below would pass vacuously.
    expect(routes.length).toBeGreaterThan(100);
  });

  it('has no route that is neither @Public nor @RequirePermission', () => {
    const unguarded = routes
      .filter((r) => r.permissions.length === 0 && !r.isPublic)
      .filter((r) => !(`${r.controller}.${r.handler}` in ALLOWED_UNGUARDED))
      .map((r) => `${r.method} ${r.path}  (${r.controller}.${r.handler})`)
      .sort();

    expect(
      unguarded,
      'These routes are reachable by ANY authenticated caller. Add @RequirePermission, ' +
        'or add an entry to ALLOWED_UNGUARDED explaining why it is safe.',
    ).toEqual([]);
  });

  it('every mutating route carries a permission (CONTRACTS §0)', () => {
    // §0: "Every mutating endpoint: @RequirePermission(<key>) + @Audited()".
    // Stated separately from the rule above because a missing guard on a
    // WRITE is a different severity from one on a read.
    const mutating = routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
    const ungated = mutating
      .filter((r) => r.permissions.length === 0 && !r.isPublic)
      .filter((r) => !(`${r.controller}.${r.handler}` in ALLOWED_UNGUARDED))
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(mutating.length, 'no mutating routes found — reflection is broken').toBeGreaterThan(50);
    expect(ungated, 'unguarded MUTATING endpoints').toEqual([]);
  });

  /**
   * A blind spot found while adding `chat/inbound` (W7): both assertions above
   * exempt `@Public` routes entirely, so a PUBLIC WRITE — the most dangerous
   * shape there is — passed the sweep without anyone recording why it was
   * safe. `@Public` means "no session", which is a statement about
   * authentication, not a licence to skip authorization.
   *
   * Every public mutating route must therefore be listed in
   * `ALLOWED_PUBLIC_MUTATIONS` with the mechanism that actually protects it.
   */
  it('every PUBLIC mutating route is explicitly justified', () => {
    const unjustified = routes
      .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
      .filter((r) => r.isPublic)
      .filter((r) => !(`${r.controller}.${r.handler}` in ALLOWED_PUBLIC_MUTATIONS))
      .map((r) => `${r.method} ${r.path}  (${r.controller}.${r.handler})`)
      .sort();

    expect(unjustified, 'PUBLIC endpoints that WRITE, with no recorded justification').toEqual([]);
  });
});
