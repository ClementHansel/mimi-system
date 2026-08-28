/**
 * A bounded, process-wide ring buffer of recent log lines — what
 * `POST /api/nodes/:id/command {type:'log_pull'}` actually sends back
 * (W3-10 hardening; previously an unconditional no-op ack, per that
 * controller's own doc comment before this ticket).
 *
 * Wraps `console.log`/`warn`/`error` ONCE per process (guarded by a marker on
 * `console` itself, not a module-local flag — `relay.ts` is constructed
 * fresh per test in this app's own test suite, and re-wrapping an
 * already-wrapped `console.log` on every `RelayEngine` construction would
 * nest wrappers indefinitely across a test file's many `startNode()` calls).
 * A shared buffer across multiple in-process `RelayEngine`s in tests is
 * harmless — this is a diagnostics aid, not correctness-bearing state.
 *
 * Deliberately does NOT attempt to scrub secrets from arbitrary log lines —
 * the actual guarantee is upstream: nothing in this codebase logs a WiFi
 * passphrase in the first place (`relay.ts`'s `redactConfig` strips it
 * before any log call that touches a `NetworkConfigWire`). A generic
 * regex-scrub here would be a false sense of safety for values it can't
 * reliably recognize.
 */
const RING_SIZE = 500;
const MAX_LINE_CHARS = 2000;

const ring: string[] = [];

function push(level: string, args: unknown[]): void {
  const rendered = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')
    .slice(0, MAX_LINE_CHARS);
  ring.push(`[${new Date().toISOString()}] [${level}] ${rendered}`);
  if (ring.length > RING_SIZE) ring.shift();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ConsoleWithMarker {
  __mimiBranchNodeLogCaptureInstalled?: boolean;
}

/** Idempotent — safe to call from every `RelayEngine` constructor. */
export function installLogCapture(): void {
  const marker = console as unknown as ConsoleWithMarker;
  if (marker.__mimiBranchNodeLogCaptureInstalled) return;
  marker.__mimiBranchNodeLogCaptureInstalled = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    push('log', args);
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    push('warn', args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', args);
    originalError(...args);
  };
}

/** The most recent `limit` lines (oldest first), capped at `RING_SIZE` regardless of what's asked. */
export function recentLogLines(limit: number): string[] {
  const n = Math.max(0, Math.min(limit, RING_SIZE));
  return ring.slice(Math.max(0, ring.length - n));
}
