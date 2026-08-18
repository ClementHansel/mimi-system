import { describe, expect, it } from 'vitest';
import {
  classifyByPorts,
  classifyMdnsService,
  dedupeByIp,
  deriveLocalSubnet,
  hostsInSubnet,
  runScan,
  simulatedDevices,
} from './scanner';

describe('classifyByPorts', () => {
  it('classifies printer ports', () => {
    expect(classifyByPorts([9100])).toBe('printer');
    expect(classifyByPorts([515])).toBe('printer');
    expect(classifyByPorts([631])).toBe('printer');
  });
  it('falls back to router for a generic web-admin port', () => {
    expect(classifyByPorts([80])).toBe('router');
  });
  it('prefers printer over web when both are open', () => {
    expect(classifyByPorts([9100, 80])).toBe('printer');
  });
  it('returns null when nothing meaningful is open', () => {
    expect(classifyByPorts([22])).toBeNull();
  });
});

describe('classifyMdnsService', () => {
  it('maps printer-ish service types', () => {
    expect(classifyMdnsService('ipp')).toBe('printer');
    expect(classifyMdnsService('_printer._tcp')).toBe('printer');
  });
  it('maps cast-capable service types to tablet', () => {
    expect(classifyMdnsService('googlecast')).toBe('tablet');
    expect(classifyMdnsService('airplay')).toBe('tablet');
  });
  it('falls back to router for anything else', () => {
    expect(classifyMdnsService('http')).toBe('router');
  });
});

describe('hostsInSubnet', () => {
  it('enumerates 254 hosts for a /24, skipping network and broadcast', () => {
    const hosts = hostsInSubnet('192.168.1.0/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts.at(-1)).toBe('192.168.1.254');
  });
  it('returns empty for an unsupported mask', () => {
    expect(hostsInSubnet('10.0.0.0/16')).toEqual([]);
  });
});

describe('deriveLocalSubnet', () => {
  it('picks a physical private /24 over a virtual adapter', () => {
    const subnet = deriveLocalSubnet({
      wsl0: [{ address: '172.20.0.5', family: 'IPv4', internal: false } as never],
      Ethernet: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as never],
    });
    expect(subnet).toBe('192.168.1.0/24');
  });
  it('returns null when there is no private interface', () => {
    expect(
      deriveLocalSubnet({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      }),
    ).toBeNull();
  });
});

describe('dedupeByIp', () => {
  it('merges duplicate ips, preferring the more specific device type', () => {
    const merged = dedupeByIp([
      {
        ipAddress: '10.0.0.5',
        macAddress: null,
        deviceType: 'router',
        vendor: null,
        model: null,
        connectionParams: { a: 1 },
        source: 'ssdp',
      },
      {
        ipAddress: '10.0.0.5',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        deviceType: 'printer',
        vendor: 'Epson',
        model: null,
        connectionParams: { b: 2 },
        source: 'mdns',
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      deviceType: 'printer',
      vendor: 'Epson',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      source: 'mdns',
    });
    expect(merged[0]!.connectionParams).toEqual({ a: 1, b: 2 });
  });
});

describe('runScan (simulate)', () => {
  it('returns simulatedDevices() immediately with no errors, and invokes onDevice per device', async () => {
    const seen: string[] = [];
    const outcome = await runScan({ simulate: true }, (d) => seen.push(d.ipAddress));
    expect(outcome.errors).toEqual([]);
    expect(outcome.devices).toEqual(simulatedDevices());
    expect(seen).toEqual(simulatedDevices().map((d) => d.ipAddress));
  });
});
