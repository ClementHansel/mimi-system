'use client';

/**
 * Driver-local glue code for talking to W2-E's `LocalRuntime`
 * (`src/lib/local/api/local-runtime.ts` — the only file of that package a
 * Wave 4 surface may import from). Mirrors `components/outlet/lib/outlet-runtime.ts`
 * and `components/pos/pos-runtime.ts` exactly (same `ActorMeta` shape, same
 * client-minted-id idiom) — this is the third surface wiring into the same
 * offline outbox, not a new pattern.
 *
 * Every driver mutation (`commitDropDeparted`, `commitDropArrived`,
 * `commitDropReceived`, `commitTempLog`) and evidence capture
 * (`captureEvidence`) goes through the runtime this file exposes — never a
 * direct `fetch`/`api.post` — so a driver 200km from the warehouse with no
 * signal still completes the drop; `sync/outbox-drain.ts` (W2-E, out of this
 * surface's ownership) is what eventually pushes it.
 */
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import { useSessionStore } from '@/stores/session-store';
import { newUuid } from '@/lib/uuid';
import type { ActorMeta, LocalRuntime } from '@/lib/local/api/local-runtime';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** Actor metadata every `commit*` call on `LocalRuntime` requires (SYNC-PROTOCOL §2.2 payload meta). */
export function useActorMeta(): ActorMeta | null {
  const user = useSessionStore((s) => s.user);
  if (!user) return null;
  return { actorUserId: user.id, actorRole: user.roleKey, appVersion: APP_VERSION };
}

/** Lazily initializes (once) and returns the singleton browser `LocalRuntime`. */
export function getDriverRuntime(): Promise<LocalRuntime> {
  return getBrowserLocalRuntime();
}

/** Client-generated id — minted once per attachment/action and reused on retry (SYNC-PROTOCOL §2.2 rule 3), same idiom every other Wave 4 offline surface uses. */
export function mintId(): string {
  return newUuid();
}
