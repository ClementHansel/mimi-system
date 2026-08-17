/**
 * REGRESSION TEST — no double /api/api prefixes in registered routes.
 *
 * On 2026-08-17 the dashboard controller had @Controller with api prefix,
 * which combined with the global prefix app.setGlobalPrefix('api', ...) in
 * main.ts produced the live route /api/api/dashboard/... silently dead,
 * unreachable at the documented /api/dashboard/... path. The frontend's
 * calls got 404s but no test caught it because the controller was syntactically
 * valid and could be instantiated in isolation.
 *
 * This test compiles the real AppModule (the same graph main.ts builds),
 * extracts the registered route tree, and asserts that ZERO routes contain
 * the substring /api/api — the canary for a redundantly-prefixed Controller.
 *
 * Every controller in apps/backend/src/modules should have
 * Controller('module-name') or Controller('module/sub'), NEVER
 * Controller('api/module') — the global prefix in main.ts adds api to all
 * of them.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { describe, it, expect, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';

const hasDb = Boolean(process.env.DATABASE_URL);

let app: INestApplication | undefined;

afterAll(async () => {
  await app?.close();
});

describe.skipIf(!hasDb)('route registration (no double /api/api prefixes)', () => {
  it('asserts that all routes omit redundant api prefix', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // Apply the same global prefix that main.ts does
    app.setGlobalPrefix('api', {
      exclude: ['/health', '/metrics'],
    });

    await app.init();

    // Get the underlying Express router from the NestJS application
    const httpServer = app.getHttpServer() as Record<string, unknown>;
    const expressRouter = httpServer._router;

    const foundRoutes = new Set<string>();

    // Traverse the router's internal stack to find all registered routes
    if (expressRouter && expressRouter.stack) {
      const processStack = (stack: unknown[], prefix = '') => {
        for (const layer of stack) {
          if (layer.route) {
            // This is a route (has methods like GET, POST, etc.)
            const routePath = prefix + (layer.route.path || '');
            if (routePath) {
              foundRoutes.add(routePath);
            }
          } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            // This is a nested router (e.g., from a controller)
            const routerPath = getRouterPrefix(layer);
            processStack(layer.handle.stack, prefix + routerPath);
          }
        }
      };

      processStack(expressRouter.stack);
    }

    // Filter for routes with the double /api/api/ substring
    const doubleApiRoutes = Array.from(foundRoutes).filter((route) => route.includes('/api/api'));

    if (doubleApiRoutes.length > 0) {
      const message =
        'Found routes with redundant /api/api prefix (should be /api/... only):\n' +
        doubleApiRoutes.map((r) => `  ${r}`).join('\n') +
        '\n\nFix: remove the "api/" prefix from Controller decorators in:\n' +
        'assets.controller.ts, components.controller.ts, loans.controller.ts, etc.\n' +
        'The global prefix in main.ts already adds "api" to all routes.';
      expect.fail(message);
    }

    // Report count for verification
    console.log(`Verified ${foundRoutes.size} routes contain no /api/api prefix`);

    // The assertion: no double /api/api routes
    expect(doubleApiRoutes).toHaveLength(0);
  }, 120_000);
});

/**
 * Helper to extract the regex pattern from a Router layer.
 * Express router layers have a regexp property that encodes the route prefix.
 */
function getRouterPrefix(layer: unknown): string {
  if (!layer || typeof layer !== 'object') return '';
  const layerObj = layer as Record<string, unknown>;
  const regexp = layerObj.regexp as RegExp | undefined;
  if (!regexp) return '';
  const source = regexp.source || '';
  // Typical regexp format: ^\\/(moduleName)(?:\\/|$)
  // Extract the module name between \\ / and (?
  const match = source.match(/^\\(\w+)/);
  if (match && match[1]) {
    return '/' + match[1];
  }
  return '';
}
