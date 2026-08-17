/**
 * LAN discovery (D-13) — ported from `../aire/aire/apps/branch-bridge/src/scanner.ts`
 * per the BUILD-PLAN W2-F brief: mDNS via `bonjour-service`, SSDP via
 * `node-ssdp`, and a bounded TCP port probe. AIRE's ONVIF/camera and MQTT
 * paths are DROPPED ENTIRELY — Mimi has no cameras or IoT bay controllers in
 * Phase 1 (the brief is explicit about this). What's left classifies the LAN
 * gear a fried-chicken outlet actually has: thermal/receipt printers,
 * routers, and — via mDNS AirPlay/Cast-style service adverts — tablets.
 *
 * Feeds `discovered_devices` (CONTRACTS block 115) so unpaired printers and
 * routers appear in the F12 topology tree (D-13); never runs in SIMULATE
 * mode, which uses `simulatedDevices()` instead.
 */
import net from 'node:net';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import { Client as SsdpClient } from 'node-ssdp';

export type DeviceType = 'printer' | 'router' | 'tablet' | 'unknown';

export type DiscoverySourceProtocol = 'mdns' | 'ssdp' | 'tcp_probe';

export interface DiscoveredDeviceInput {
  ipAddress: string;
  macAddress: string | null;
  deviceType: DeviceType;
  vendor: string | null;
  model: string | null;
  connectionParams: Record<string, unknown>;
  /** Which discovery protocol found this device (CONTRACTS block 115 `discovered_devices.source`). */
  source: DiscoverySourceProtocol;
}

export interface ScanError {
  protocol: string;
  message: string;
}

export interface ScanOutcome {
  devices: DiscoveredDeviceInput[];
  errors: ScanError[];
}

export interface ScanOptions {
  simulate: boolean;
  subnet?: string;
  protocols?: string[];
  /** Per-protocol discovery window; kept short so a scheduled scan stays bounded. */
  timeoutMs?: number;
}

// ── Port classification (printers + a generic web-admin fallback for routers) ──

/** Network-printer ports (JetDirect/raw 9100, LPD 515, IPP 631). */
export const PRINTER_PORTS = [9100, 515, 631];
/** Generic web-admin ports that imply "a router/web-managed appliance" — the only fallback classification, since a Mimi outlet has no cameras/NVRs to rule out. */
export const WEB_PORTS = [80, 8080];

export const PROBE_PORTS = [...PRINTER_PORTS, ...WEB_PORTS, 443, 8443];

/** Classify by which probed ports are open, most-specific first. `null` = nothing meaningful open. */
export function classifyByPorts(openPorts: number[]): DeviceType | null {
  const has = (ports: number[]) => ports.some((p) => openPorts.includes(p));
  if (has(PRINTER_PORTS)) return 'printer';
  if (has(WEB_PORTS)) return 'router';
  return null;
}

/** Map an mDNS service type to a device type — printers/scanners and cast-capable tablets only (no camera/RTSP/ONVIF path). */
export function classifyMdnsService(serviceType: string): DeviceType {
  const s = serviceType.toLowerCase();
  if (s.includes('ipp') || s.includes('printer') || s.includes('pdl-datastream') || s.includes('scanner') || s.includes('uscan')) {
    return 'printer';
  }
  if (s.includes('airplay') || s.includes('raop') || s.includes('googlecast') || s.includes('androidtvremote')) {
    return 'tablet';
  }
  return 'router';
}

/** `true` for a private (RFC1918) IPv4 address. */
function isPrivateV4(address: string): boolean {
  const o = address.split('.').map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

/** Virtual/host-only adapter names (WSL, Docker, VPN, ...) — de-prioritised so a scan doesn't silently pick a fake subnet. */
function isVirtualAdapter(name: string): boolean {
  return /vethernet|wsl|docker|hyper-v|virtualbox|vmware|vmnet|loopback|tailscale|zerotier|utun|tun\d|tap\d/i.test(name);
}

/** Every distinct private /24 across the host's interfaces, physical adapters first. */
export function deriveLocalSubnets(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const physical: string[] = [];
  const virtual: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      const isV4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (!isV4 || info.internal || !isPrivateV4(info.address)) continue;
      const octets = info.address.split('.');
      if (octets.length !== 4) continue;
      const cidr = `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
      (isVirtualAdapter(name) ? virtual : physical).push(cidr);
    }
  }
  return [...new Set([...physical, ...virtual])];
}

export function deriveLocalSubnet(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  return deriveLocalSubnets(interfaces)[0] ?? null;
}

/** Enumerate host addresses for a /24 CIDR (skips .0 network and .255 broadcast). */
export function hostsInSubnet(cidr: string): string[] {
  const [base, maskRaw] = cidr.split('/');
  const mask = parseInt(maskRaw ?? '24', 10);
  if (mask !== 24) return []; // only /24 supported by this simple probe
  const octets = (base ?? '').split('.');
  if (octets.length !== 4) return [];
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i += 1) hosts.push(`${prefix}.${i}`);
  return hosts;
}

/** Single TCP connect attempt; 'closed' = actively refused (definitive), 'timeout' = no response (ambiguous, worth one retry). */
export function probePortStatus(ip: string, port: number, timeoutMs: number): Promise<'open' | 'closed' | 'timeout'> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (r: 'open' | 'closed' | 'timeout') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', () => done('closed'));
    socket.connect(port, ip);
  });
}

async function probePortReliable(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  const first = await probePortStatus(ip, port, timeoutMs);
  if (first === 'open') return true;
  if (first === 'closed') return false;
  return (await probePortStatus(ip, port, timeoutMs)) === 'open'; // timeout -> one retry
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** De-duplicate by ip_address (first wins, merges connection params); a more specific type beats a weaker one. */
export function dedupeByIp(devices: DiscoveredDeviceInput[]): DiscoveredDeviceInput[] {
  const byIp = new Map<string, DiscoveredDeviceInput>();
  const rank: Record<DeviceType, number> = { printer: 8, tablet: 5, router: 2, unknown: 1 };
  for (const device of devices) {
    const existing = byIp.get(device.ipAddress);
    if (!existing) {
      byIp.set(device.ipAddress, device);
      continue;
    }
    const deviceIsMoreSpecific = rank[device.deviceType] > rank[existing.deviceType];
    byIp.set(device.ipAddress, {
      ...existing,
      deviceType: deviceIsMoreSpecific ? device.deviceType : existing.deviceType,
      source: deviceIsMoreSpecific ? device.source : existing.source,
      macAddress: existing.macAddress ?? device.macAddress,
      vendor: existing.vendor ?? device.vendor,
      model: existing.model ?? device.model,
      connectionParams: { ...existing.connectionParams, ...device.connectionParams },
    });
  }
  return [...byIp.values()];
}

/** Two synthetic devices for SIMULATE mode — a printer and a router, so discovery has something real to report without any LAN at all. */
export function simulatedDevices(): DiscoveredDeviceInput[] {
  return [
    {
      ipAddress: '127.0.0.1',
      macAddress: '02:00:00:00:00:01',
      deviceType: 'printer',
      vendor: 'MimiSim',
      model: 'Virtual Thermal Printer',
      connectionParams: { open_ports: [9100] },
      source: 'mdns',
    },
    {
      ipAddress: '127.0.0.2',
      macAddress: '02:00:00:00:00:02',
      deviceType: 'router',
      vendor: 'MimiSim',
      model: 'Virtual Router',
      connectionParams: { open_ports: [80] },
      source: 'tcp_probe',
    },
  ];
}

interface ProtocolResult {
  protocol: string;
  devices: DiscoveredDeviceInput[];
  error?: ScanError;
}

async function scanMdns(timeoutMs: number): Promise<ProtocolResult> {
  const protocol = 'mdns';
  const serviceTypes = [
    { type: 'ipp', protocol: 'tcp' as const },
    { type: 'printer', protocol: 'tcp' as const },
    { type: 'http', protocol: 'tcp' as const },
  ];
  const bonjour = new Bonjour();
  const devices: DiscoveredDeviceInput[] = [];
  try {
    const browsers = serviceTypes.map((svc) =>
      bonjour.find({ type: svc.type, protocol: svc.protocol }, (service) => {
        const ip = (service.addresses || []).find((a) => net.isIPv4(a)) || service.referer?.address || service.host;
        if (!ip) return;
        devices.push({
          ipAddress: ip,
          macAddress: null,
          deviceType: classifyMdnsService(svc.type),
          vendor: null,
          model: service.name || service.fqdn || null,
          connectionParams: { mdns_service: `_${svc.type}._${svc.protocol}`, port: service.port, host: service.host },
          source: 'mdns',
        });
      }),
    );
    await new Promise((r) => setTimeout(r, timeoutMs));
    browsers.forEach((b) => b.stop());
    return { protocol, devices };
  } catch (e) {
    return { protocol, devices, error: { protocol, message: (e as Error).message } };
  } finally {
    bonjour.destroy();
  }
}

async function scanSsdp(timeoutMs: number): Promise<ProtocolResult> {
  const protocol = 'ssdp';
  const devices: DiscoveredDeviceInput[] = [];
  const client = new SsdpClient();
  return new Promise<ProtocolResult>((resolve) => {
    client.on('response', (headers, _code, rinfo) => {
      const ip = rinfo?.address;
      if (!ip) return;
      const h = headers as Record<string, unknown>;
      const location = (h.LOCATION as string | undefined) || (h.Location as string | undefined);
      const server = (h.SERVER as string | undefined) || (h.Server as string | undefined) || null;
      // Routers/NAS/print-servers advertised via SSDP -> classify as router (generic network-appliance fallback).
      devices.push({
        ipAddress: ip,
        macAddress: null,
        deviceType: 'router',
        vendor: server,
        model: null,
        connectionParams: location ? { ssdp_location: location } : {},
        source: 'ssdp',
      });
    });
    try {
      client.search('ssdp:all');
    } catch (e) {
      client.stop();
      resolve({ protocol, devices, error: { protocol, message: (e as Error).message } });
      return;
    }
    setTimeout(() => {
      client.stop();
      resolve({ protocol, devices });
    }, timeoutMs);
  });
}

/** Read the OS ARP cache into an ip -> MAC map (best-effort; populated by the TCP probe's connect attempts). */
async function readArpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const parse = (text: string) => {
    const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[^\n]*?([0-9a-fA-F]{2}([:-])[0-9a-fA-F]{2}(\3[0-9a-fA-F]{2}){4})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const ip = m[1]!;
      const mac = m[2]!.replace(/-/g, ':').toLowerCase();
      if (mac !== 'ff:ff:ff:ff:ff:ff' && mac !== '00:00:00:00:00:00') map.set(ip, mac);
    }
  };
  const cmds: [string, string[]][] =
    process.platform === 'win32' ? [['arp', ['-a']]] : [['ip', ['neigh']], ['arp', ['-an']]];
  for (const [cmd, args] of cmds) {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 4000 });
      parse(stdout);
      if (map.size > 0) break;
    } catch {
      /* try next command */
    }
  }
  return map;
}

async function scanTcpSubnet(subnet: string, timeoutMs: number): Promise<ProtocolResult> {
  const protocol = 'tcp';
  try {
    const hosts = hostsInSubnet(subnet);
    if (hosts.length === 0) {
      return { protocol, devices: [], error: { protocol, message: `unsupported subnet: ${subnet}` } };
    }
    const devices: DiscoveredDeviceInput[] = [];
    // Probe every host's ports IN PARALLEL — a filtering host makes every probe a
    // full timeout, so a serial per-host sweep would blow past a bounded scan window.
    await mapWithConcurrency(hosts, 48, async (ip) => {
      const probed = await Promise.all(
        PROBE_PORTS.map((port) => probePortReliable(ip, port, timeoutMs).then((open) => (open ? port : null))),
      );
      const openPorts = probed.filter((p): p is number => p !== null);
      const type = classifyByPorts(openPorts);
      if (type) {
        devices.push({ ipAddress: ip, macAddress: null, deviceType: type, vendor: null, model: null, connectionParams: { open_ports: openPorts }, source: 'tcp_probe' });
      }
    });
    const arp = await readArpTable();
    for (const d of devices) {
      const mac = arp.get(d.ipAddress);
      if (mac) d.macAddress = mac;
    }
    return { protocol, devices };
  } catch (e) {
    return { protocol, devices: [], error: { protocol, message: (e as Error).message } };
  }
}

/**
 * Run a full LAN scan. Each protocol runs independently (`Promise.allSettled`)
 * so one failure never aborts the others. In SIMULATE mode, returns
 * `simulatedDevices()` immediately — no bonjour/ssdp/socket activity at all.
 */
export async function runScan(options: ScanOptions, onDevice?: (device: DiscoveredDeviceInput) => void): Promise<ScanOutcome> {
  if (options.simulate) {
    const devices = simulatedDevices();
    devices.forEach((d) => onDevice?.(d));
    return { devices, errors: [] };
  }

  const timeoutMs = options.timeoutMs ?? 4000;
  const wanted = options.protocols;
  const want = (p: string) => !wanted || wanted.length === 0 || wanted.includes(p);
  const subnets = options.subnet ? [options.subnet] : deriveLocalSubnets();

  const tasks: Promise<ProtocolResult>[] = [];
  if (want('mdns')) tasks.push(scanMdns(timeoutMs));
  if (want('ssdp')) tasks.push(scanSsdp(timeoutMs));
  if (want('tcp')) {
    if (subnets.length > 0) {
      for (const subnet of subnets) tasks.push(scanTcpSubnet(subnet, 800));
    } else {
      tasks.push(Promise.resolve<ProtocolResult>({ protocol: 'tcp', devices: [], error: { protocol: 'tcp', message: 'could not derive a local /24 subnet' } }));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const allDevices: DiscoveredDeviceInput[] = [];
  const errors: ScanError[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allDevices.push(...result.value.devices);
      if (result.value.error) errors.push(result.value.error);
    } else {
      errors.push({ protocol: 'unknown', message: String(result.reason) });
    }
  }

  const deduped = dedupeByIp(allDevices);
  deduped.forEach((d) => onDevice?.(d));
  return { devices: deduped, errors };
}
