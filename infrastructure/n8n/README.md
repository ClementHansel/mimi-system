# n8n (automation: WhatsApp + payroll-slip notifications)

Config-only directory (no application code) — the n8n _service_ is defined
in `docker-compose.yml` (dev) and gets Traefik routing labels in
`docker-compose.prod.yml`.

## Layout

- `workflows/` — exported workflow JSON, mounted read-only into the n8n
  container at `/home/node/.n8n/workflows`. `wa-notify.json` (W2-C) is the
  WhatsApp send path: `Webhook /wa-notify` → validate payload → `HTTP
Request` to the real WA gateway (retried 3x, then a wired error output) →
  `Respond to Webhook` (200/400/502). The HTTP Request node's URL
  (`WA_GATEWAY_URL` env var) and credential (`httpHeaderAuth`, id
  `REPLACE_WITH_REAL_WA_GATEWAY_CREDENTIAL_ID`) are PLACEHOLDERS until RISK-P4
  resolves — see that node's `notes` field after importing. W5-04 live-tests
  this workflow once real gateway credentials exist. Import via the n8n UI
  or `n8n import:workflow --input=workflows/wa-notify.json`.
- `data/` — n8n's own runtime state (credentials, execution history) when you
  want it outside the named `n8n_data` volume for backup/inspection. Not
  committed (see root `.gitignore`); the named volume is the default and is
  what ships.

## WhatsApp channel wiring (D-03 / RISK-P4)

The backend never talks to a WhatsApp SDK directly. It POSTs to
`N8N_WEBHOOK_URL_WA` (see `.env.example`); the n8n workflow owns the actual
WA gateway call. Until the client supplies real WA gateway credentials:

- Keep `WA_ENABLED=false` — the backend writes to the `notification_outbox`
  table (`channel='whatsapp'`, CONTRACTS.md migration 006) instead of calling
  the webhook at all, so the whole pipeline (compose → build → queue) is
  exercised without a live gateway (mirrors AIRE's `WAHA_MOCK` pattern). See
  `apps/backend/src/kernel/notification/channels/whatsapp-channel.service.ts`.
- Flip `WA_ENABLED=true` and drop real gateway credentials into the n8n
  credential store once RISK-P4 is resolved. No backend code or migration
  changes needed for that flip.

## First run

```bash
docker compose up -d n8n
# open http://localhost:${N8N_PORT:-5678}, create the owner account,
# then import workflows/*.json once they exist.
```
