/**
 * The node's `/bridge` control-plane link to the cloud `node-gateway` (M22) —
 * registration over HTTP, then one outbound socket.io connection for
 * heartbeat/discovery/commands. Pattern ported from AIRE's
 * `branch-bridge/src/cloud-client.ts` (polling-first transport, so a flaky/
 * absent WebSocket upgrade behind a branch router doesn't cause connect
 * churn) — this is the "proven AIRE bridge shape" SYNC-PROTOCOL §4.1 asks
 * for, applied to the `/bridge` namespace specifically.
 *
 * NEVER an inbound port: this class only ever calls out.
 */
import { io } from 'socket.io-client';
import type { MinimalSocket, SocketFactory } from './socket-like';
import type {
  CommandAck,
  DiscoveryReport,
  LogsChunk,
  NodeCommand,
  NodeHeartbeat,
  NodeRegisterRequest,
  NodeRegisterResponse,
  CertRotated,
  ConfigUpdated,
  NetworkConfigAck,
} from './bridge-types';

/** `POST /api/nodes/register` (CONTRACTS §4.22) — public endpoint, single-use pairing token in the body. */
export async function registerNode(
  cloudUrl: string,
  req: NodeRegisterRequest,
): Promise<NodeRegisterResponse> {
  const res = await fetch(`${cloudUrl}/api/nodes/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`node registration failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as NodeRegisterResponse;
}

export interface BridgeHandlers {
  onCommand: (cmd: NodeCommand) => void | Promise<void>;
  onCertRotated?: (cert: CertRotated) => void | Promise<void>;
  onConfigUpdated?: (update: ConfigUpdated) => void | Promise<void>;
  onRevoked?: () => void | Promise<void>;
}

export class BridgeClient {
  private socket: MinimalSocket;

  constructor(
    cloudUrl: string,
    nodeToken: string,
    private handlers: BridgeHandlers,
    socketFactory?: SocketFactory,
  ) {
    const factory = socketFactory ?? ((url, opts) => io(url, opts) as unknown as MinimalSocket);
    this.socket = factory(`${cloudUrl}/bridge`, {
      auth: { token: nodeToken },
      reconnection: true,
      transports: ['polling', 'websocket'],
    });
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.socket.on('connect', () => console.log('[bridge-client] connected to /bridge'));
    this.socket.on('disconnect', (...args: unknown[]) =>
      console.log(`[bridge-client] disconnected: ${args[0]}`),
    );
    this.socket.on('connect_error', (...args: unknown[]) =>
      console.error('[bridge-client] connect_error:', (args[0] as Error)?.message),
    );

    this.socket.on(
      'command',
      (...args: unknown[]) => void this.handlers.onCommand(args[0] as NodeCommand),
    );
    this.socket.on(
      'cert_rotated',
      (...args: unknown[]) => void this.handlers.onCertRotated?.(args[0] as CertRotated),
    );
    this.socket.on(
      'config_updated',
      (...args: unknown[]) => void this.handlers.onConfigUpdated?.(args[0] as ConfigUpdated),
    );
    this.socket.on('revoked', () => void this.handlers.onRevoked?.());
  }

  isConnected(): boolean {
    return this.socket.connected;
  }

  waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out connecting to cloud /bridge')),
        timeoutMs,
      );
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  sendHeartbeat(heartbeat: NodeHeartbeat): void {
    this.socket.emit('node:heartbeat', heartbeat);
  }

  sendDiscoveryReport(report: DiscoveryReport): void {
    this.socket.emit('discovery:report', report);
  }

  ackCommand(ack: CommandAck): void {
    this.socket.emit('command:ack', ack);
  }

  sendLogsChunk(chunk: LogsChunk): void {
    this.socket.emit('logs:chunk', chunk);
  }

  /** The apply-then-confirm outcome for a `config_updated` push (W3-10) — sent exactly once, after
   *  the confirm window resolves one way or the other (never mid-flight). */
  sendNetworkConfigAck(ack: NetworkConfigAck): void {
    this.socket.emit('network_config_ack', ack);
  }

  disconnect(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
