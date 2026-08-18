/**
 * The minimal socket surface `cloud-sync-client.ts`/`bridge-client.ts` use.
 * A real `socket.io-client` `Socket` satisfies this structurally (it has
 * every member here, with compatible signatures), so production code passes
 * one through unchanged. Tests inject a lightweight in-process fake instead
 * (`test/fake-socket-pair.ts`) — no real network, no new dependency, and it
 * exercises the exact same call sites as the real socket would.
 */
export interface MinimalSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  removeAllListeners(): void;
  disconnect(): void;
}

export type SocketFactory = (
  url: string,
  opts: { auth: { token: string }; reconnection: boolean; transports: string[] },
) => MinimalSocket;
