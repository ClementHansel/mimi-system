import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A WhatsApp SANDBOX — a local stand-in for the two hops between the backend
 * and a phone (RISK-P4, and the "delivery unproven" caveat on W7 chat).
 *
 * WHY THIS EXISTS. The backend never calls a WA SDK: it POSTs to
 * `N8N_WEBHOOK_URL_WA`, and the n8n `wa-notify` workflow calls the real
 * gateway (`infrastructure/n8n/README.md`). Both hops were therefore
 * untestable without credentials nobody has yet, which left the outbound half
 * of chat and every WA notification shipped-but-never-executed: with
 * `WA_ENABLED=false` the send path is a `return` statement, so no test had
 * ever run the `fetch`, the response handling, or the outbox transitions that
 * `WA_ENABLED=true` unlocks on the day the client hands over a token.
 *
 * WHAT IT IS HONEST ABOUT. This sandbox is not WhatsApp. It cannot prove a
 * message reaches a handset, that a template was approved, or that Meta's
 * 24-hour customer-service window applies. What it proves is the CONTRACT the
 * backend depends on, which is where our own bugs live:
 *
 *   1. `POST /webhook/wa-notify` — the n8n webhook, replying with the same
 *      three outcomes the real workflow's three `respondToWebhook` nodes do:
 *      200 `{ok:true,messageId}`, 400 on a payload missing `to`/`text`, and
 *      502 when the gateway hop fails. The backend's success/failure branches
 *      and its outbox writes then execute for real.
 *   2. `POST /v22.0/:phoneNumberId/messages` — the shape the n8n HTTP Request
 *      node calls, mirroring Meta Cloud API's `{messages:[{id:"wamid...."}]}`
 *      response, so `WA_GATEWAY_URL` can point HERE in dev and the workflow
 *      itself runs end to end without a credential.
 *   3. `deliverInbound()` — pushes a reply INTO the backend's `/chat/inbound`,
 *      secret header included, so the receiving half is exercised by a real
 *      HTTP request arriving from outside the process.
 *
 * The failure modes are first-class rather than an afterthought:
 * `setFailureMode` makes the gateway reject, stall, or return a 200 whose body
 * is malformed — because "the UI said sent and nothing left" is the one
 * failure this feature must never have.
 */
export type WaFailureMode = 'none' | 'gateway-error' | 'timeout' | 'malformed-response';

export interface WaSandboxMessage {
  /** Meta-style id, so anything that stores a provider id stores a realistic one. */
  wamid: string;
  to: string;
  text: string;
  templateKey: string | null;
  params: Record<string, string>;
  receivedAt: string;
}

export interface WaSandbox {
  /** e.g. `http://127.0.0.1:53124`. */
  readonly baseUrl: string;
  /** Point `N8N_WEBHOOK_URL_WA` at this. */
  readonly webhookUrl: string;
  /** Point n8n's `WA_GATEWAY_URL` at this. */
  readonly gatewayUrl: string;
  /** Everything the sandbox has accepted, newest last. */
  messages(): WaSandboxMessage[];
  lastMessage(): WaSandboxMessage | undefined;
  reset(): void;
  setFailureMode(mode: WaFailureMode): void;
  /** Delivers an inbound reply to a backend `/chat/inbound` URL. */
  deliverInbound(
    backendInboundUrl: string,
    secret: string,
    message: { phone: string; body: string; externalId?: string; occurredAt?: string },
  ): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export interface WaSandboxOptions {
  /** 0 (the default) takes an ephemeral port, so parallel test files cannot collide. */
  port?: number;
  /** How long `timeout` mode stalls. Short by default so a test proving that path does not itself hang. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    // A body that is not JSON is the caller's bug; naming it beats a 500 that
    // reads as though the sandbox itself broke.
    return { __unparseable: true };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startWaSandbox(options: WaSandboxOptions = {}): Promise<WaSandbox> {
  const timeoutMs = options.timeoutMs ?? 500;
  const log = options.log ?? (() => {});
  const accepted: WaSandboxMessage[] = [];
  let failureMode: WaFailureMode = 'none';

  const newWamid = () => `wamid.SANDBOX${randomUUID().replace(/-/g, '').toUpperCase()}`;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://sandbox.local');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, accepted: accepted.length, failureMode });
      return;
    }

    // Inspection + control, for a human driving the sandbox by hand.
    if (req.method === 'GET' && path === '/messages') {
      send(res, 200, { messages: accepted });
      return;
    }
    if (req.method === 'POST' && path === '/control/failure-mode') {
      const body = await readJson(req);
      failureMode = (body.mode as WaFailureMode) ?? 'none';
      send(res, 200, { ok: true, failureMode });
      return;
    }
    if (req.method === 'POST' && path === '/control/reset') {
      accepted.length = 0;
      failureMode = 'none';
      send(res, 200, { ok: true });
      return;
    }

    // ── Hop 1: the n8n `wa-notify` webhook the BACKEND calls ────────────────
    if (req.method === 'POST' && path === '/webhook/wa-notify') {
      const body = await readJson(req);
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      const text = typeof body.text === 'string' ? body.text.trim() : '';

      // Mirrors the workflow's `IF: payload has to + text` → `Respond: bad
      // request`. A 400 here is a bug on OUR side, so it must not look like a
      // transient gateway problem that a retry would fix.
      if (!to || !text) {
        send(res, 400, { ok: false, error: 'Malformed payload: to and text are required' });
        return;
      }

      if (failureMode === 'timeout') await sleep(timeoutMs);
      if (failureMode === 'gateway-error') {
        send(res, 502, { ok: false, error: 'WA gateway request failed' });
        return;
      }
      if (failureMode === 'malformed-response') {
        // 200 with a body that is not the agreed shape — the nastiest case,
        // because a caller trusting the status code alone reports success.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":');
        return;
      }

      const message: WaSandboxMessage = {
        wamid: newWamid(),
        to,
        text,
        templateKey: typeof body.templateKey === 'string' ? body.templateKey : null,
        params: (body.params as Record<string, string>) ?? {},
        receivedAt: new Date().toISOString(),
      };
      accepted.push(message);
      log(`wa-sandbox -> ${message.to}: ${message.text.slice(0, 60)}`);
      send(res, 200, { ok: true, messageId: message.wamid });
      return;
    }

    // ── Hop 2: the Meta Cloud API shape the n8n workflow itself calls ───────
    const graph = /^\/v\d+\.\d+\/([^/]+)\/messages$/.exec(path);
    if (req.method === 'POST' && graph) {
      const body = await readJson(req);
      const to = typeof body.to === 'string' ? body.to : '';
      if (!to) {
        send(res, 400, {
          error: { message: '(#100) Missing parameter: to', type: 'OAuthException', code: 100 },
        });
        return;
      }
      if (failureMode === 'gateway-error') {
        send(res, 500, {
          error: { message: 'Something went wrong', type: 'OAuthException', code: 1 },
        });
        return;
      }
      const wamid = newWamid();
      accepted.push({
        wamid,
        to,
        text:
          (body.text as { body?: string } | undefined)?.body ??
          (typeof body.message === 'string' ? body.message : ''),
        templateKey: null,
        params: {},
        receivedAt: new Date().toISOString(),
      });
      send(res, 200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id: wamid, message_status: 'accepted' }],
      });
      return;
    }

    send(res, 404, { ok: false, error: `No sandbox route for ${req.method} ${path}` });
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    webhookUrl: `${baseUrl}/webhook/wa-notify`,
    gatewayUrl: `${baseUrl}/v22.0/1234567890/messages`,
    messages: () => [...accepted],
    lastMessage: () => accepted[accepted.length - 1],
    reset: () => {
      accepted.length = 0;
      failureMode = 'none';
    },
    setFailureMode: (mode) => {
      failureMode = mode;
    },
    async deliverInbound(backendInboundUrl, secret, message) {
      const response = await fetch(backendInboundUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
        body: JSON.stringify({
          phone: message.phone,
          body: message.body,
          // A real provider always supplies its own id; passing one through is
          // what makes the backend's dedupe path reachable at all.
          externalId: message.externalId ?? `wamid.SANDBOXIN${randomUUID().replace(/-/g, '')}`,
          occurredAt: message.occurredAt ?? new Date().toISOString(),
        }),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave it as text — the caller asserts on it either way */
      }
      return { status: response.status, body: parsed };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
