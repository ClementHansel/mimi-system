'use client';

/**
 * Outlet-local glue code for talking to W2-E's `LocalRuntime`
 * (`src/lib/local/api/local-runtime.ts` — the only file of that package a
 * Wave 4 surface may import from, per that module's own doc comment). Mirrors
 * `components/pos/pos-runtime.ts`'s pattern exactly (same `ActorMeta`
 * shape, same client-minted-id idiom) since receiving (F04) and POS (F02)
 * are the two outlet-adjacent surfaces that actually commit through the
 * offline runtime today.
 *
 * Scope note: only the receiving flow (`commitDropReceived`) is wired
 * through here. Opname/waste/return/petty-cash have no `SyncEntity`/op
 * mapping in `LocalRuntime` yet — see `outlet-api.ts`'s doc comment; that
 * gap is tracked separately, not silently patched by routing them through
 * `enqueueFact` with an invented entity/op pair.
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
export function getOutletRuntime(): Promise<LocalRuntime> {
  return getBrowserLocalRuntime();
}

/** Client-generated id — minted once per attachment/action and reused on retry (SYNC-PROTOCOL §2.2 rule 3), same idiom as `pos-runtime.ts`'s `mintClientId`. */
export function mintId(): string {
  return newUuid();
}
