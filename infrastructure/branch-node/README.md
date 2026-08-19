# Branch node — field installation and fleet update (W5-07)

> **Deploying real branch-node hardware to outlets is a CHANGE ORDER (RISK-P5).**
> This directory being populated does not mean that decision has been made. The
> hardware-free default (`SIMULATE=true`, see the last section) needs nothing
> from this directory.
>
> This file replaced a placeholder that listed what W5-07 was expected to
> deliver. Two of those items are still outstanding and are tracked at the
> bottom under **Still owed**, so replacing the placeholder does not quietly
> lose them.

The branch node is **optional** (Tier 2, D-12/RISK-P5). An outlet without one
works fine: its tablets talk to the cloud directly and the topology tree
renders that outlet with `node: null`. Install a node only where the internet
is unreliable enough that the outlet needs to keep trading through an outage.

Everything here is for the **mini-PC that lives at the outlet**. The cloud side
is `docker-compose.vps.yml` at the repo root and has nothing to do with this
file.

---

## What the node actually is

One container plus its own Postgres:

- Holds **one outbound** socket.io connection to the cloud. It never accepts an
  inbound connection from the internet, so **no port forwarding, ever**. If
  someone asks you to open a port on the outlet router for this, the answer is
  no and something has been misunderstood.
- Keeps a **local database** so the outlet keeps working while the link is
  down, then reconciles when it returns.
- Runs **LAN discovery** (mDNS / SSDP / bounded TCP probe) so printers and
  tablets in the outlet appear in the topology screen without anyone typing an
  IP address.

## Before you go to the outlet

| Need                                   | Why                                                             |
| -------------------------------------- | --------------------------------------------------------------- |
| A mini-PC with Docker + Docker Compose | Nothing else is installed on it                                 |
| Wired ethernet to the outlet router    | Wifi flaps; the node is the thing that is supposed to be stable |
| The outlet's `locationId`              | Needed to mint the pairing token                                |
| An owner/manager login                 | `node.manage` permission is required to mint                    |

The box needs outbound HTTPS to the cloud. It needs **no static IP from the
ISP** and no inbound rule — but give it a **static LAN address** (or a DHCP
reservation), because `NODE_LAN_BIND` and the tablets both depend on it not
moving.

---

## Install

### 1. Copy the package onto the box

```bash
sudo mkdir -p /opt/mimi-node && cd /opt/mimi-node
# copy docker-compose.node.yml and node.env.example here
cp node.env.example node.env
```

### 2. Fill in `node.env`

Every field is documented in the file itself. The two that are easy to get
wrong:

- `NODE_LAN_BIND` — the box's **LAN** address, e.g. `192.168.1.50`. It defaults
  to `127.0.0.1` on purpose: a half-configured box should be useless, not
  exposed.
- `NODE_POSTGRES_PASSWORD` — generate a long random value. It never leaves the
  box, and losing the volume it protects loses queued outlet work.

### 3. Turn the outlet's node setting ON, then mint a pairing token

**Order matters.** The API refuses to mint a token for an outlet whose
branch-node setting is still OFF (D-26), so a node can never end up paired to
an outlet nobody enabled:

```
PUT  /api/nodes/outlet-setting/:locationId     { "nodeEnabled": true }
POST /api/nodes/pairing-tokens                 { "locationId": "<uuid>" }
```

Both are reachable from the owner UI (Topologi Perangkat). The response carries
the token and a short display code. Two more rules the API enforces, so you do
not discover them at the outlet:

- **One node per location.** Minting fails if that outlet already has a paired
  node. Unpair the old one first (`POST /api/nodes/:id/unpair`).
- **Tokens expire.** Mint it when you are ready to install, not the week before.

Paste the token into `BRANCH_NODE_PAIRING_TOKEN` in `node.env`.

### 4. Start it

```bash
docker compose --env-file node.env -f docker-compose.node.yml up -d
docker compose --env-file node.env -f docker-compose.node.yml logs -f branch-node
```

### 5. Verify — do not skip this

Three checks, in order. Each rules out a different failure:

```bash
# a) The node is alive on the LAN (run ON the box)
curl -s http://127.0.0.1:4010/health

# b) A tablet on the outlet wifi can reach it (run from a tablet/laptop)
curl -s http://<NODE_LAN_BIND>:4010/health

# c) The CLOUD believes it is paired — this is the one that matters
#    Topologi Perangkat → the outlet should show its node as `online`.
```

If (a) passes and (c) does not, the node is running but has not registered:
read the container logs, which name the reason.

### 6. Blank the token (optional, recommended)

After a successful registration the node holds its own credential and no longer
needs the pairing token. Blank `BRANCH_NODE_PAIRING_TOKEN` in `node.env` so a
one-time secret is not left sitting on the box.

It is **not** blanked automatically, deliberately: a node that rewrote its own
config on first boot would be much harder to reason about when a re-pair goes
wrong, and the token is single-use anyway.

---

## Fleet update

Nodes are updated by changing the pinned image and restarting. There is no
auto-updater, on purpose — an outlet mid-service is not a good place for an
unattended version change.

```bash
cd /opt/mimi-node
sed -i 's|^NODE_IMAGE=.*|NODE_IMAGE=ghcr.io/<org>/mimi-branch-node:<new>|' node.env
docker compose --env-file node.env -f docker-compose.node.yml pull
docker compose --env-file node.env -f docker-compose.node.yml up -d
```

The local Postgres volume is untouched by an image change, so queued work
survives the update. **Update outside trading hours** and verify with step 5
before leaving.

> **Not yet built:** there is no signed image, no registry publish step in CI,
> and no remote "update all nodes" path. Today an update is a person on the
> box. That is honest for a Phase-1.5 component with zero units deployed;
> when the fleet grows past a handful, `POST /api/nodes/:id/command` is the
> hook a remote updater would use.

---

## Removing a node

```
POST /api/nodes/:id/unpair
```

Then on the box:

```bash
docker compose --env-file node.env -f docker-compose.node.yml down
```

Keep the volume until you are certain the node had nothing queued. `down -v`
destroys it, and with it anything the outlet captured that never reached the
cloud.

---

## Troubleshooting

| Symptom                                            | Most likely cause                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Container restarts in a loop at boot               | `NODE_POSTGRES_PASSWORD` unset — compose fails the variable check by design                          |
| `/health` answers on the box but not from a tablet | `NODE_LAN_BIND` is still `127.0.0.1`                                                                 |
| Node runs, cloud shows it offline                  | Pairing never completed — check logs for the register response; token may be expired or already used |
| "outlet's branch-node setting is OFF" when minting | Step 3, first call — enable the outlet before minting                                                |
| "already has a paired branch node"                 | One node per location; unpair the previous one                                                       |
| Dates land a day early in the morning              | `TZ`/`PGTZ` not `Asia/Makassar` — both are set in the compose file, so suspect a hand-edited copy    |

---

## Testing without hardware

The image runs hardware-free with `SIMULATE=true` — no LAN, no real cloud, no
mini-PC. That is how CI and every developer exercise it:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --profile branch-node up -d branch-node
```

`SIMULATE=true` is the image's default precisely so an accidentally-unconfigured
container does something harmless instead of trying to pair against production.

---

## Still owed by W5-07

Carried forward from the placeholder this file replaced, so they are not lost:

- **`install.sh`** — a one-shot installer that writes `node.env`, starts the
  stack and registers it as a **system service**. The compose file's
  `restart: unless-stopped` survives a reboot of the Docker daemon, but nothing
  here yet guarantees Docker itself starts on boot of a fresh mini-PC. Until
  that exists, installation is the manual steps above.
- **Signed images + offline verification** — no image signature, no checksum,
  and no registry publish step in CI. An installer cannot currently verify what
  it is about to run on customer hardware.
- **Fleet self-update channel** — updating is a person on the box (see _Fleet
  update_). A real channel must still never require an inbound port; the node
  only ever dials out.

None of these block a pilot install; all three block shipping nodes at scale.
