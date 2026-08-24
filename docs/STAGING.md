# Staging — from a bare server to a verified deployment

The demo box (`150.109.15.108`) is a shared VPS with seven unrelated projects on
it, reached over a high port with a self-signed certificate. Staging is the first
environment that is **ours alone**, with a real hostname and a real certificate,
and it is where the two things that cannot be simulated get resolved: a trusted
TLS certificate, and WhatsApp against a real gateway.

This is the order to do it in, and the checks that say whether it worked. Every
step here has been exercised somewhere — the failures called out are ones this
system actually had, not hypotheticals.

---

## 0. What you need before touching the server

| Thing                  | Why                                                                    | Notes                                                            |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A hostname you control | Let's Encrypt validates over HTTP; there is no certificate without DNS | e.g. `ops.mimichicken.co.id`                                     |
| **Four** DNS A records | One per public service                                                 | `@`, `api.`, `storage.`, `n8n.` — all pointing at the staging IP |
| Ports 80 and 443 free  | ACME needs `:80`, TLS needs `:443`                                     | This is why the demo box could never have a real certificate     |
| An ops email           | Certificate expiry warnings                                            | `ACME_EMAIL`                                                     |
| SSH access + Docker    |                                                                        | Compose v2                                                       |

`storage.` is the one people forget. Presigned upload URLs are signed for it, and
without it the backend hands phones the internal `http://minio:9000` — which no
device can resolve, and which an HTTPS page blocks as mixed content anyway. On
the demo box that made attendance selfies and waste photos **impossible for
weeks** while `presign` cheerfully returned 200. Both are mandatory fields, so
the features were dead behind a healthy-looking API.

---

## 1. Bring the stack up

```bash
git clone <repo> /home/ubuntu/mimi && cd /home/ubuntu/mimi
cp .env.prod.example .env            # fill EVERY CHANGE_ME
# set DOMAIN and ACME_EMAIL; generate real secrets:
#   openssl rand -base64 36     (per password/secret — do not reuse one)

docker compose -p mimi -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Certificates take up to a minute per hostname on first boot. `docker logs
mimi-traefik | grep -i acme` tells you where it is.

## 2. Migrate — before anything else touches the database

```bash
docker run --rm --network mimi_mimi-network \
  -v /home/ubuntu/mimi:/app -w /app/database \
  -e DATABASE_MIGRATION_URL="$DATABASE_MIGRATION_URL" \
  -e DATABASE_URL="$DATABASE_URL" \
  node:22-alpine sh -c 'corepack enable && corepack prepare pnpm@9.15.4 --activate && pnpm migrate'
```

Missing this step once meant an RLS fix sat unapplied while the code that assumed
it shipped — the stack came up "healthy" and quietly behaved as though the fix
were not there.

## 3. Decide what data staging starts with

**Two options, and they are not interchangeable.**

**a. Seeded demo data** — `pnpm db:seed`. Produces the real org (60 supervisors,
60 cashiers, 120 cooks, 2 gudang staff, 2 drivers, regional managers plus a
head-office manager) with plausible history. Right for a staging box people are
learning on. Every account uses the demo password, so this must never hold real
payroll.

**b. Restored from a production/demo dump** — right when staging is a rehearsal
for a real cutover. Prove the dump first, on your own machine:

```bash
pnpm --filter @mimi/database drill:restore
```

That dumps, restores into a scratch database, compares every table row-for-row
plus a money spot-check, and drops it. An untested backup is not a backup.

Then, on staging, restore with `--no-owner --no-privileges` — roles and grants
come from migrations, which own them, and a dump carrying `OWNER TO` statements
fails on a box whose roles differ.

## 4. Verify — in this order, because each answers a different question

```bash
# reachable and healthy
curl -sI https://${DOMAIN}/            | head -1
curl -s  https://api.${DOMAIN}/health

# certificates are REAL (no -k anywhere; that is the point of staging)
curl -sI https://api.${DOMAIN}/health  | head -1

# can a device actually upload a photo? (runs inside the backend container)
docker cp infrastructure/tls/storage-probe.mjs mimi-backend:/app/storage-probe.mjs
docker exec mimi-backend node /app/storage-probe.mjs
# expect: "public  : PUT 200"
```

The storage probe signs and PUTs against **both** the internal and the public
endpoint, because "both failed" means credentials and "only the public one
failed" means the proxy — a distinction the app's own `SignatureDoesNotMatch`
cannot make.

Then drive a whole business day through the API as the real crews:

```bash
API=https://api.${DOMAIN}/api npx tsx database/simulate-day.ts
```

Expect **0 findings**. It logs in as a supervisor, a cashier, two cooks, both
regional managers, warehouse and a driver; opens a till, rings a sale, closes it;
clocks people in inside the 200 m geofence and refuses a check-in 5 km out;
raises a stock request and walks it to the warehouse queue; records spoilage; and
asserts the boundaries hold — a cook refused a till, a cashier refused another
branch's sales, a manager refused another region.

## 5. Only now: the two things staging exists for

### A trusted certificate

Nothing to do beyond steps 0–1 — Traefik issues it. The check is that step 4
passes **without `-k`**. If it does not, the answer is almost always DNS: a
missing record for one of the four hostnames.

### WhatsApp against a real gateway

Everything on our side is already proven against a sandbox
(`pnpm --filter @mimi/backend wa:sandbox`), including the failure modes. What
remains needs a person:

1. A Meta developer account and a test number (business identity + an OTP —
   not something automation can create).
2. Put the gateway URL and token in the n8n credential store; import
   `infrastructure/n8n/workflows/wa-notify.json`.
3. Set `WA_ENABLED=true` and `N8N_WEBHOOK_URL_WA`, plus a real
   `N8N_WEBHOOK_SECRET` for the inbound direction.
4. Restart the backend and send one message from the chat inbox.

The cutover is a flag and a URL — no code change. That was the point of building
against a sandbox.

---

## Rollback

```bash
git reset --hard <previous-sha>
docker compose -p mimi -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**Migrations do not roll back.** Every one is written to be additive, so an older
image runs against a newer schema; the reverse is not true. If a migration is the
problem, restore from the pre-deploy dump (step 3b) — which is why step 3 says to
prove the restore before you need it.

## Two traps this project has already fallen into

**A bind-mounted config file changing does not restart anything.** Compose sees
an identical container and leaves it running; `git reset --hard` replaces the
file, and a single-file bind mount stays pinned to the old inode, so even
`nginx -s reload` re-reads the stale copy. A corrected proxy header deployed
green **twice** and changed nothing. Recreate the container that mounts it.

**Deploy checks that only test the happy port hide everything else.** `:8080`
answered 200 throughout a period when no photo could be uploaded at all. Every
check in step 4 exists because something passed while the feature underneath was
dead.
