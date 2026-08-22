/**
 * Runs the WA sandbox as a standalone process, for driving chat and WA
 * notifications by hand:
 *
 *   pnpm --filter @mimi/backend wa:sandbox            # ephemeral port
 *   WA_SANDBOX_PORT=5678 pnpm --filter @mimi/backend wa:sandbox
 *
 * Then set `WA_ENABLED=true` and point `N8N_WEBHOOK_URL_WA` at the printed
 * webhook URL, restart the backend, and every WA send in the app lands here
 * instead of nowhere. `GET /messages` is the transcript.
 *
 * Deliberately separate from `wa-sandbox.ts`: the sandbox is imported by tests
 * and must not bind a port or print anything as a side effect of being
 * imported. Only this file has a side effect.
 */
import { startWaSandbox } from './wa-sandbox';

async function main(): Promise<void> {
  const port = process.env.WA_SANDBOX_PORT ? Number.parseInt(process.env.WA_SANDBOX_PORT, 10) : 0;

  const sandbox = await startWaSandbox({
    port,
    log: (line) => console.log(line),
  });

  console.log(
    [
      '',
      'WhatsApp sandbox listening.',
      '',
      `  N8N_WEBHOOK_URL_WA=${sandbox.webhookUrl}`,
      `  WA_GATEWAY_URL=${sandbox.gatewayUrl}    (for the n8n workflow itself)`,
      '',
      `  transcript      GET  ${sandbox.baseUrl}/messages`,
      `  break it        POST ${sandbox.baseUrl}/control/failure-mode  {"mode":"gateway-error"}`,
      `  fix it          POST ${sandbox.baseUrl}/control/reset`,
      '',
      'This is NOT WhatsApp: nothing reaches a handset. It proves the contract',
      'between the backend and the gateway, so WA_ENABLED=true is exercised',
      'before real credentials exist (RISK-P4).',
      '',
    ].join('\n'),
  );

  const shutdown = () => {
    void sandbox.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
