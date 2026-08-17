# Branch-node packaging (Tier 2, optional, D-12/D-13)

Config-only directory (no application code) — reserved for the signed,
self-updating Docker image + install script that W5-07 (branch-node
hardening) packages for on-prem deployment at an outlet.

Expected eventual contents:
- `install.sh` — pulls the signed `mimi-branch-node` image, writes a local
  `.env` (cloud URL, pairing token), starts it via a minimal compose file,
  registers it as a system service so it survives a reboot of the mini-PC.
- `update-channel.md` — how the fleet self-update mechanism polls for and
  applies new signed images (must never require an inbound port on the
  outlet LAN — the node only ever dials out).
- Signing/verification notes (image signature, checksum) so an installer
  can be verified offline before running on customer hardware.

Nothing here is required for the hardware-free default deployment
(`apps/branch-node` runs standalone with `SIMULATE=true` via
`docker-compose.dev.yml`, no files from this directory are read). Deploying
real branch-node hardware to outlets is a change order per RISK-P5 — do not
assume this directory is populated before that decision is made.
