/**
 * The node's LAN-facing upstream listener — SYNC-PROTOCOL §4.1's HTTP
 * fallback (`GET/POST /sync/v1/*`), plus the local `/health` endpoint
 * (BUILD-PLAN W2-F brief).
 *
 * DEPENDENCY NOTE (flagged in the W2-F report): §1.2/§4.1 describe the node
 * as running a socket.io `/sync` NAMESPACE for LAN devices, the same as the
 * cloud does. The branch-node package manifest (W1-A) provisions
 * `socket.io-client` (for THIS node's own outbound connections, in
 * `cloud-sync-client.ts` and `bridge-client.ts`) but not the `socket.io`
 * SERVER package needed to host a namespace for inbound LAN connections, and
 * "no new dependencies — anything else goes to W1-A" is a hard constraint.
 * Rather than add it myself, this listener implements ONLY the §4.1 HTTP
 * fallback, which the spec explicitly describes as carrying "the same JSON
 * bodies as the socket messages" — a fully wire-compatible transport, just
 * pull-driven instead of push-driven (no live `sync:deliver`; a device
 * polls `GET /sync/v1/pull` instead). Devices behind a node therefore work
 * correctly but see server-pushed events on their next poll rather than
 * instantly. Adding `socket.io` to `apps/branch-node/package.json` would
 * close that gap — see the report's follow-ups for W1-A / W2-E.
 *
 * LAN HTTPS (RISK-S1, SYNC-PROTOCOL §1.3): serves HTTPS using the node's
 * `lanCert` (delivered by the cloud at registration) whenever one is
 * present and valid; falls back to plain HTTP otherwise (SIMULATE mode, or
 * before the first cert has arrived) — Node's built-in `https` module needs
 * no new dependency for this.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { LanCert } from './store/types';

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface LanServerHandlers {
  nodeHealth(): Promise<HandlerResult>;
  syncHealth(): HandlerResult;
  hello(body: unknown): Promise<HandlerResult>;
  push(body: unknown): Promise<HandlerResult>;
  pull(cursor: number, limit: number): Promise<HandlerResult>;
  bootstrap(body: unknown): Promise<HandlerResult>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // generous fallback cap; §4.3/§4.5 already bound batch/page sizes tighter

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export class LanServer {
  private server: http.Server | https.Server;
  private listening = false;
  private cert: LanCert | null;

  constructor(
    private handlers: LanServerHandlers,
    cert: LanCert | null,
  ) {
    this.cert = cert;
    this.server = this.buildServer(cert);
  }

  private buildServer(cert: LanCert | null): http.Server | https.Server {
    const listener = (req: IncomingMessage, res: ServerResponse) => void this.route(req, res);
    return cert
      ? https.createServer({ cert: cert.pem, key: cert.keyPem }, listener)
      : http.createServer(listener);
  }

  /** Swaps in a freshly-issued LAN cert (rotation, §1.3) — requires a listen()/close() cycle to take effect on a live port. */
  async rotateCert(cert: LanCert, port: number): Promise<void> {
    await this.close();
    this.cert = cert;
    this.server = this.buildServer(cert);
    await this.listen(port);
  }

  /**
   * W3-10: rebinds this listener to a new port (a remotely-applied `healthPort` network-config
   * change) — same cert, new port. Binds a CANDIDATE server on the new port FIRST and only swaps it
   * in once that succeeds, so a successful rebind never has a downtime gap and a FAILED one never
   * touches the currently-live listener at all (the old port keeps serving LAN devices right up
   * until the moment a working replacement exists). Throws (never resolves) on a bind failure —
   * already in use, out of range, insufficient privilege on a <1024 port — which `RelayEngine`'s
   * `handleNetworkConfigUpdate` treats as an immediate, no-timeout-needed reason to revert, rather
   * than waiting out the full confirm window for a failure it already knows about.
   */
  async rebind(port: number): Promise<void> {
    const candidate = this.buildServer(this.cert);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      candidate.once('error', onError);
      candidate.listen(port, () => {
        candidate.off('error', onError);
        resolve();
      });
    });
    await this.close();
    this.server = candidate;
    this.listening = true;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://node.local');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/health') {
        const r = await this.handlers.nodeHealth();
        sendJson(res, r.status, r.body);
        return;
      }
      if (req.method === 'GET' && path === '/sync/v1/health') {
        const r = this.handlers.syncHealth();
        sendJson(res, r.status, r.body);
        return;
      }
      if (req.method === 'POST' && path === '/sync/v1/hello') {
        const r = await this.handlers.hello(await readJsonBody(req));
        sendJson(res, r.status, r.body);
        return;
      }
      if (req.method === 'POST' && path === '/sync/v1/push') {
        const r = await this.handlers.push(await readJsonBody(req));
        sendJson(res, r.status, r.body);
        return;
      }
      if (req.method === 'GET' && path === '/sync/v1/pull') {
        const cursor = Number(url.searchParams.get('cursor') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '500');
        const r = await this.handlers.pull(cursor, limit);
        sendJson(res, r.status, r.body);
        return;
      }
      if (req.method === 'POST' && path === '/sync/v1/bootstrap') {
        const r = await this.handlers.bootstrap(await readJsonBody(req));
        sendJson(res, r.status, r.body);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: (e as Error).message });
    }
  }

  /**
   * Rejects (never crashes the process) on a bind failure — EADDRINUSE, an invalid/out-of-range
   * port, or insufficient privilege on a <1024 port. Before this fix, `http.Server.listen()`'s
   * `'error'` event had no listener at all, so a bind failure was an UNCAUGHT exception that would
   * take the whole node process down — exactly backwards for `rebind()` (W3-10), whose entire
   * contract depends on a bind failure being a catchable, revertable outcome rather than a crash.
   */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, () => {
        this.server.off('error', onError);
        this.listening = true;
        resolve();
      });
    });
  }

  isListening(): boolean {
    return this.listening;
  }

  /** The actual bound port — useful when `listen(0)` let the OS pick one (tests). `null` if not listening. */
  address(): { port: number } | null {
    if (!this.listening) return null;
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? { port: addr.port } : null;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.listening) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.listening = false;
        resolve();
      });
    });
  }
}
