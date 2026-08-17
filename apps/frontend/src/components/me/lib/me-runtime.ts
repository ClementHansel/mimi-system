'use client';

/**
 * `me`-local glue code for talking to W2-E's `LocalRuntime`
 * (`src/lib/local/api/local-runtime.ts`) — mirrors
 * `components/outlet/lib/outlet-runtime.ts`'s pattern exactly (same
 * `ActorMeta` shape, same client-minted-id idiom), because Absen's
 * check-in/out is squarely the offline-first case `LocalRuntime` was built
 * for: `commitAttendanceCheckIn`/`commitAttendanceCheckOut` already exist
 * (local-runtime.ts:211,215), backed cloud-side by W3-09's
 * `AttendanceSyncProjector` (`defensibleAt` clamp + `time_suspect`/
 * `time_disputed` tagging for exactly the untrustworthy-clock case a
 * just-reconnected phone is in). There is no gap to flag here — unlike
 * `components/outlet/lib/outlet-api.ts`'s genuine one for opname/waste/
 * petty-cash/return (tracked separately as B-11), attendance's local-runtime
 * mapping already exists end to end.
 */
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import { useSessionStore } from '@/stores/session-store';
import type { ActorMeta, LocalRuntime } from '@/lib/local/api/local-runtime';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** Actor metadata every `commit*` call on `LocalRuntime` requires (SYNC-PROTOCOL §2.2 payload meta). */
export function useActorMeta(): ActorMeta | null {
  const user = useSessionStore((s) => s.user);
  if (!user) return null;
  return { actorUserId: user.id, actorRole: user.roleKey, appVersion: APP_VERSION };
}

/** Lazily initializes (once) and returns the singleton browser `LocalRuntime`. */
export function getMeRuntime(): Promise<LocalRuntime> {
  return getBrowserLocalRuntime();
}

/** Client-generated id — minted once per attendance day/attachment and reused on retry (SYNC-PROTOCOL §2.2 rule 3), same idiom as `outlet-runtime.ts`'s `mintId`. */
export function mintId(): string {
  return crypto.randomUUID();
}
