/**
 * `PUT /api/nodes/:id/network-config` validation (W3-10 hardening) — pure
 * functions, no I/O, so every rule here is unit-testable without a live DB.
 *
 * The owner's own framing for why this file exists: "a malformed static IP
 * or a port collision should be rejected by the API, not discovered by an
 * outlet going dark." A few things this CANNOT catch (only the node itself,
 * at bind time, can know another process already holds a given port on that
 * specific machine — see `apps/branch-node/src/network/applier.ts`'s doc
 * comment) are deliberately left to the node's own apply-then-confirm/revert
 * loop; this file's job is everything checkable BEFORE a byte reaches the
 * outlet.
 */

export interface NetworkConfigInput {
  healthPort?: number;
  scanSubnet?: string | null;
  wifiSsid?: string;
  wifiPassphrase?: string;
  staticIp?: string;
  subnetMask?: string;
  gateway?: string;
  dns?: string[];
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Ports this platform's own stack commonly occupies (compose defaults —
 * `docker-compose.yml`/`.env.example`) plus universally-reserved
 * ones (SSH, RDP, common DB/proxy ports). A single-outlet install can
 * plausibly run the branch node on the SAME machine as other Mimi Chicken
 * services (or a customer's existing kiosk software), so this is a real,
 * checkable collision — not exhaustive (only the node's own bind attempt can
 * ever be exhaustive), but catches the likely, known cases before they ever
 * reach the outlet.
 */
const KNOWN_RESERVED_PORTS = new Set([
  22, 80, 443, 3000, 3306, 3389, 4000, 5432, 6379, 8080, 8443, 9000, 9001,
]);
const MIN_PORT = 1024; // privileged range (<1024) excluded outright — never a sane node.js listen target
const MAX_PORT = 65535;

function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function isValidIPv4(ip: unknown): ip is string {
  return typeof ip === 'string' && ipv4ToInt(ip) !== null;
}

/** A subnet mask must be a run of 1-bits followed by a run of 0-bits (contiguous) — `255.0.255.0` is
 *  syntactically four valid octets but not a real subnet mask. */
function isContiguousMask(maskInt: number): boolean {
  const inverted = ~maskInt >>> 0;
  // `inverted + 1` is a power of two (or 0, for a /32 all-ones mask) exactly when `inverted` is a
  // contiguous run of 1-bits starting from bit 0 — i.e. the mask itself is a contiguous run of 1s
  // from the top.
  return (inverted & (inverted + 1)) === 0;
}

function isValidCidr(value: string): boolean {
  const [ip, prefix] = value.split('/');
  if (!ip || prefix === undefined) return false;
  if (ipv4ToInt(ip) === null) return false;
  const p = Number(prefix);
  return Number.isInteger(p) && p >= 0 && p <= 32;
}

/** WPA2-PSK ASCII passphrase length bounds (IEEE 802.11i) — a raw 64-hex-char PSK is accepted too. */
function isPlausibleWifiPassphrase(value: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  return value.length >= 8 && value.length <= 63;
}

export function validateNetworkConfig(
  input: NetworkConfigInput,
  ctx: { hasExistingWifiSsid: boolean },
): FieldError[] {
  const errors: FieldError[] = [];
  const hasAnyField =
    input.healthPort !== undefined ||
    input.scanSubnet !== undefined ||
    input.wifiSsid !== undefined ||
    input.wifiPassphrase !== undefined ||
    input.staticIp !== undefined ||
    input.subnetMask !== undefined ||
    input.gateway !== undefined ||
    input.dns !== undefined;
  if (!hasAnyField) {
    errors.push({ field: '_', message: 'at least one network-config field is required' });
    return errors;
  }

  if (input.healthPort !== undefined) {
    if (!isValidPort(input.healthPort)) {
      errors.push({
        field: 'healthPort',
        message: `healthPort must be an integer between ${MIN_PORT} and ${MAX_PORT}`,
      });
    } else if (KNOWN_RESERVED_PORTS.has(input.healthPort)) {
      errors.push({
        field: 'healthPort',
        message: `healthPort ${input.healthPort} is reserved by this platform's own services — choose a different port`,
      });
    }
  }

  if (input.scanSubnet !== undefined && input.scanSubnet !== null) {
    if (!isValidCidr(input.scanSubnet)) {
      errors.push({
        field: 'scanSubnet',
        message: 'scanSubnet must be a valid CIDR, e.g. "192.168.1.0/24"',
      });
    }
  }

  if (input.wifiSsid !== undefined) {
    if (
      typeof input.wifiSsid !== 'string' ||
      input.wifiSsid.length < 1 ||
      input.wifiSsid.length > 32 ||
      /[\x00-\x1f\x7f]/.test(input.wifiSsid)
    ) {
      errors.push({
        field: 'wifiSsid',
        message: 'wifiSsid must be 1-32 characters with no control characters',
      });
    }
  }

  if (input.wifiPassphrase !== undefined) {
    if (
      typeof input.wifiPassphrase !== 'string' ||
      !isPlausibleWifiPassphrase(input.wifiPassphrase)
    ) {
      errors.push({
        field: 'wifiPassphrase',
        message: 'wifiPassphrase must be 8-63 characters (WPA2-PSK) or a 64-character hex PSK',
      });
    }
    if (input.wifiSsid === undefined && !ctx.hasExistingWifiSsid) {
      errors.push({
        field: 'wifiPassphrase',
        message:
          'wifiPassphrase requires wifiSsid to be set in the same request (no SSID is on file for this node yet)',
      });
    }
  }

  const staticFieldsGiven = [input.staticIp, input.subnetMask, input.gateway].filter(
    (v) => v !== undefined,
  ).length;
  if (staticFieldsGiven > 0 && staticFieldsGiven < 3) {
    errors.push({
      field: 'staticIp',
      message:
        'staticIp, subnetMask, and gateway must be set together — a static config needs all three',
    });
  } else if (staticFieldsGiven === 3) {
    const ipInt = isValidIPv4(input.staticIp) ? ipv4ToInt(input.staticIp!) : null;
    const maskInt = isValidIPv4(input.subnetMask) ? ipv4ToInt(input.subnetMask!) : null;
    const gwInt = isValidIPv4(input.gateway) ? ipv4ToInt(input.gateway!) : null;

    if (ipInt === null)
      errors.push({ field: 'staticIp', message: 'staticIp must be a valid IPv4 address' });
    if (maskInt === null)
      errors.push({ field: 'subnetMask', message: 'subnetMask must be a valid IPv4 address' });
    else if (!isContiguousMask(maskInt))
      errors.push({
        field: 'subnetMask',
        message: 'subnetMask must be a contiguous mask, e.g. 255.255.255.0',
      });
    if (gwInt === null)
      errors.push({ field: 'gateway', message: 'gateway must be a valid IPv4 address' });

    if (ipInt !== null && maskInt !== null && gwInt !== null && isContiguousMask(maskInt)) {
      if ((ipInt & maskInt) !== (gwInt & maskInt)) {
        errors.push({
          field: 'gateway',
          message: `gateway ${input.gateway} is not reachable from staticIp ${input.staticIp} under subnetMask ${input.subnetMask} — they must be on the same network`,
        });
      }
      if (ipInt === gwInt) {
        errors.push({
          field: 'staticIp',
          message: 'staticIp must not be the same address as gateway',
        });
      }
    }
  }

  if (input.dns !== undefined) {
    if (!Array.isArray(input.dns) || input.dns.length === 0 || input.dns.length > 4) {
      errors.push({
        field: 'dns',
        message: 'dns must be a non-empty array of at most 4 IPv4 addresses',
      });
    } else {
      input.dns.forEach((d, i) => {
        if (!isValidIPv4(d))
          errors.push({ field: `dns[${i}]`, message: `dns[${i}] must be a valid IPv4 address` });
      });
    }
  }

  return errors;
}
