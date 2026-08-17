/**
 * The real `SyncTransport` — fetch against the HTTP-fallback endpoints
 * (SYNC-PROTOCOL §4.1 / CONTRACTS.md §4.23 table): `/sync/v1/health`,
 * `/sync/v1/hello`, `/sync/v1/push`, `/sync/v1/pull`, plus
 * `/api/devices/heartbeat` for telemetry (§4.6). Authenticates with the
 * device credential (§1.5) as a Bearer token — the actor/user JWT never
 * enters this layer (a device with an expired user session must still be
 * able to drain its outbox).
 */
import type { SyncHelloAck, SyncHelloRequest, SyncPullResult, SyncPushAck, SyncPushBatch } from '@mimi/sync-protocol';
import type { HeartbeatAck, HeartbeatPayload, SyncHealth, SyncTransport } from './types';
import { HEALTH_PROBE_TIMEOUT_MS } from '../constants';

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { ...init, signal: controller?.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${url}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHttpTransport(deviceToken: () => string | null): SyncTransport {
  function authHeaders(): Record<string, string> {
    const token = deviceToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  return {
    async health(baseUrl) {
      return fetchJson<SyncHealth>(joinUrl(baseUrl, '/sync/v1/health'), { method: 'GET' }, HEALTH_PROBE_TIMEOUT_MS);
    },

    async hello(baseUrl, req: SyncHelloRequest) {
      return fetchJson<SyncHelloAck>(joinUrl(baseUrl, '/sync/v1/hello'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(req),
      });
    },

    async push(baseUrl, batch: SyncPushBatch) {
      return fetchJson<SyncPushAck>(joinUrl(baseUrl, '/sync/v1/push'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(serializeBatch(batch)),
      });
    },

    async pull(baseUrl, cursor, limit) {
      return fetchJson<SyncPullResult>(
        joinUrl(baseUrl, `/sync/v1/pull?cursor=${cursor}&limit=${limit}`),
        { method: 'GET', headers: authHeaders() },
      );
    },

    async heartbeat(baseUrl, payload: HeartbeatPayload) {
      return fetchJson<HeartbeatAck>(joinUrl(baseUrl, '/api/devices/heartbeat'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
    },
  };
}

/** `clientSeq` is a `bigint` in the envelope (structured-clone-safe in IndexedDB) but JSON has no BigInt literal — serialize as a decimal string, matching how CONTRACTS.md's `client_seq BIGINT` already crosses JSON boundaries everywhere else in this codebase. */
function serializeBatch(batch: SyncPushBatch): unknown {
  return {
    ...batch,
    events: batch.events.map((e) => ({ ...e, clientSeq: e.clientSeq.toString() })),
  };
}
