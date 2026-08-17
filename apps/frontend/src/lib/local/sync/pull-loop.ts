/**
 * The pull side — SYNC-PROTOCOL §4.5. Cursors are per-upstream and
 * non-transferable: `cursors` store keys on `'cloud' | 'node'`, and a switch
 * of upstream (upstream-selector.ts) simply resumes whichever cursor that
 * upstream owns — overlap re-delivery across the switch is expected and
 * harmless because `reconciler.ts`'s dedupe window absorbs it.
 *
 * "The downstream applies a pulled page atomically with its cursor advance"
 * (§4.5) — `reconcilePulledEvents` and the cursor write happen in the SAME
 * `runTransaction` call here, so a crash mid-page re-pulls the whole page
 * next time (dedupe absorbs the overlap) rather than silently skipping it.
 */
import type { LocalDatabase } from '../store/local-database';
import type { CursorRecord, UpstreamKind } from '../types';
import type { SyncTransport } from '../transport/types';
import { reconcilePulledEvents, type ReconcileOptions } from './reconciler';
import { PULL_PAGE_LIMIT } from '../constants';

export interface PullResult {
  pagesApplied: number;
  eventsApplied: number;
  cursor: number;
}

export async function pullUntilCaughtUp(
  db: LocalDatabase,
  transport: SyncTransport,
  baseUrl: string,
  upstream: UpstreamKind,
  options: ReconcileOptions = {},
): Promise<PullResult> {
  const cursorStore = db.store<CursorRecord>('cursors');
  const cursorRow = await cursorStore.get(upstream);
  let cursor = cursorRow?.cursor ?? 0;

  let pagesApplied = 0;
  let eventsApplied = 0;

  for (;;) {
    const page = await transport.pull(baseUrl, cursor, PULL_PAGE_LIMIT);
    if (page.events.length > 0) {
      const result = await reconcilePulledEvents(db, page.events, options);
      eventsApplied += result.applied;
    }

    cursor = page.nextCursor;
    await cursorStore.put({ upstream, cursor, updatedAt: new Date().toISOString() });
    pagesApplied += 1;

    if (!page.hasMore) break;
  }

  return { pagesApplied, eventsApplied, cursor };
}
