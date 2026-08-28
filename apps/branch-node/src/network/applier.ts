/**
 * W3-10 hardening: what this branch-node build can genuinely DO with a
 * remotely-pushed network config (`config_updated` / `NetworkConfigWire`,
 * `../bridge-types.ts`).
 *
 * HONEST SCOPE, read before extending this file:
 *
 * `healthPort` (this node's own LAN listener port, `LanServer`) and
 * `scanSubnet` (the LAN discovery scan target) are ordinary in-process
 * Node.js state — this class rebinds/reassigns them for real, no OS
 * privileges needed, and `RelayEngine` genuinely applies, confirms, and (on
 * failure) reverts them.
 *
 * `wifiSsid` / `wifiPassphrase` / `staticIp` / `subnetMask` / `gateway` /
 * `dns` are OS network-interface concerns — changing a mini-PC's WiFi
 * association or its interface's static IP requires host-level privileges
 * and a platform-specific mechanism (`nmcli`/`netplan` on Linux, `netsh` on
 * Windows, entirely different again inside a container with no host network
 * namespace access, which is exactly how this app runs in every environment
 * this ticket could actually exercise — see `docker-compose*.yml`). This
 * repo has:
 *   - no dependency for any of those tools ("no new dependencies without
 *     W1-A" — the same constraint `lan-server.ts`'s own doc comment cites),
 *   - no host-privileged execution path from this process today, and
 *   - no way for this session to verify a real OS network mutation even if
 *     one were written (no bare-metal mini-PC available to test against,
 *     and shelling out to `nmcli`/`netsh` untested is exactly the kind of
 *     change that could brick a real outlet's network the way this
 *     ticket's own safety mandate warns against).
 *
 * So: this applier accepts those fields (the API validates and the cloud
 * stores them — a future OS-integration build has real data to work from
 * the moment it exists) but reports them back `applied: false` with an
 * explicit reason, through the SAME per-field ack channel `healthPort`/
 * `scanSubnet` use. This is the deliberate alternative to the ack-that-
 * pretends this ticket named as the exact thing not to ship: no field is
 * ever silently dropped, and nothing claims a WiFi/IP change happened when
 * it didn't.
 *
 * `SimulateNetworkApplier` below exists ONLY for tests/SIMULATE — it fakes
 * success on every field so the apply-then-confirm/revert state machine in
 * `relay.ts` can be exercised end-to-end without a real OS integration
 * existing yet. It must never be wired in for a real (non-SIMULATE) node.
 */
import type { NetworkConfigWire } from '../bridge-types';

export interface FieldApplyResult {
  field: string;
  applied: boolean;
  reason: string;
}

/** The callbacks a `NetworkConfigApplier` needs into the running node — kept narrow (not a full
 *  `RelayEngine` reference) so the applier can't reach into anything beyond what it's meant to touch. */
export interface NetworkConfigApplyContext {
  /** Rebinds the LAN listener to a new port. MUST throw synchronously (propagate the bind error) if
   *  the port cannot be bound — `RelayEngine` uses that to skip the confirm-timeout wait entirely and
   *  revert immediately, per this ticket's "a malformed static IP or a port collision should be
   *  rejected... not discovered by an outlet going dark" (the port-collision half of that: the API
   *  can validate the NUMBER is sane, but only THIS machine, at bind time, can know another process
   *  already holds it). */
  rebindLanServer(port: number): Promise<void>;
  setScanSubnet(subnet: string | null): void;
}

const UNSUPPORTED_FIELDS = [
  'wifiSsid',
  'wifiPassphrase',
  'staticIp',
  'subnetMask',
  'gateway',
  'dns',
] as const;

export interface NetworkConfigApplier {
  /**
   * Applies every field this build can, in order, and returns a result for EVERY field present in
   * `config` — appliable or not. Throws only if an appliable field's OWN apply step fails (e.g.
   * `rebindLanServer` throwing on EADDRINUSE); an unsupported field is never a throw.
   */
  apply(config: NetworkConfigWire): Promise<FieldApplyResult[]>;
}

/** The real (and, today, ONLY non-test) applier — see the file doc comment for exactly which fields
 *  this actually mutates versus reports unsupported. */
export class InProcessNetworkApplier implements NetworkConfigApplier {
  constructor(private readonly ctx: NetworkConfigApplyContext) {}

  async apply(config: NetworkConfigWire): Promise<FieldApplyResult[]> {
    const results: FieldApplyResult[] = [];

    if (config.healthPort !== undefined) {
      await this.ctx.rebindLanServer(config.healthPort); // throws through on bind failure — see doc comment
      results.push({ field: 'healthPort', applied: true, reason: 'ok' });
    }
    if (config.scanSubnet !== undefined) {
      this.ctx.setScanSubnet(config.scanSubnet);
      results.push({ field: 'scanSubnet', applied: true, reason: 'ok' });
    }
    for (const field of UNSUPPORTED_FIELDS) {
      if (config[field] !== undefined) {
        results.push({ field, applied: false, reason: 'unsupported_no_os_network_manager' });
      }
    }
    return results;
  }
}

/** SIMULATE/tests only — see the file doc comment. Fakes every field as applied, including the
 *  OS-level ones, so tests can exercise the confirm/revert state machine without a real OS
 *  integration existing. */
export class SimulateNetworkApplier implements NetworkConfigApplier {
  constructor(private readonly ctx: NetworkConfigApplyContext) {}

  async apply(config: NetworkConfigWire): Promise<FieldApplyResult[]> {
    const results: FieldApplyResult[] = [];
    if (config.healthPort !== undefined) {
      await this.ctx.rebindLanServer(config.healthPort);
      results.push({ field: 'healthPort', applied: true, reason: 'ok' });
    }
    if (config.scanSubnet !== undefined) {
      this.ctx.setScanSubnet(config.scanSubnet);
      results.push({ field: 'scanSubnet', applied: true, reason: 'ok' });
    }
    for (const field of UNSUPPORTED_FIELDS) {
      if (config[field] !== undefined) {
        results.push({ field, applied: true, reason: 'ok_simulated' });
      }
    }
    return results;
  }
}
