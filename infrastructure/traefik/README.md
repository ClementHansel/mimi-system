# Traefik (production reverse proxy)

Config-only directory (no application code). Traefik itself is started as
the `traefik` service in `docker-compose.prod.yml`, using the aivory
(`avry-vps-traefik`) pattern: static config passed as CLI args in the
compose command, dynamic config (TLS options, middleware) loaded from
`dynamic/*.yml` here.

- `dynamic/tls-config.yml` — minimum TLS 1.2, strong cipher suites, strict SNI.
- Add further dynamic files (rate limiting, security headers, IP allowlists)
  as `dynamic/*.yml` — Traefik's file provider picks up any `.yml` in this
  directory automatically; no compose change needed.

**Not tracked** (see root `.gitignore`): `letsencrypt/acme.json` — the Let's
Encrypt account key and issued certificate private keys. That volume
(`traefik_certs`) lives only on the VPS.

## Bring-up order

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Traefik and the app services start together (they share `mimi-network` from
the base compose file already). Watch `docker compose logs -f traefik` on
first boot — cert issuance for three hostnames (`${DOMAIN}`, `api.${DOMAIN}`,
`n8n.${DOMAIN}`) can take up to ~60s.

## Rollback

Routing config lives entirely in compose-file labels + this directory — a
bad change is `git revert` + `docker compose up -d --build` on the affected
service, no data loss risk. The `traefik_certs` volume is untouched by any
routing change.
