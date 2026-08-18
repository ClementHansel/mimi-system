/**
 * Receipt printing via Web Bluetooth ESC/POS (58/80mm thermal printers) —
 * FR-POS-01/04. Pure byte-builder functions are exported separately from the
 * Bluetooth transport so they're unit-testable without a browser Bluetooth
 * stack; `printReceipt` is the one function a screen calls.
 *
 * Money/qty are formatted via `@/lib/formatters` (decimal-string safe) —
 * this module never does its own number math on a receipt line.
 */
import { formatMoney, formatQty } from '@/lib/formatters';
import type { Money, Qty } from '@/lib/shared-types';

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  INIT: [ESC, 0x40],
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  CUT: [GS, 0x56, 0x01],
  FEED: (lines: number) => [ESC, 0x64, lines],
};

export interface ReceiptLine {
  productName: string;
  qty: Qty;
  unitPrice: Money;
  lineTotal: Money;
}

export interface ReceiptData {
  outletName: string;
  receiptNumber: string;
  kasirName: string;
  occurredAt: string;
  lines: ReceiptLine[];
  subtotal: Money;
  discount: Money;
  total: Money;
  paidAmount: Money;
  changeAmount: Money;
  paymentMethodLabel: string;
  paperWidth: 58 | 80;
}

const CHARS_PER_LINE: Record<58 | 80, number> = { 58: 32, 80: 48 };

function padRow(left: string, right: string, width: number): string {
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function wrapCenter(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/** Builds the plain-text receipt body (also usable for an on-screen preview / a printer-less fallback). */
export function buildReceiptText(data: ReceiptData): string {
  const width = CHARS_PER_LINE[data.paperWidth];
  const rule = '-'.repeat(width);
  const rows: string[] = [];
  rows.push(wrapCenter(data.outletName, width));
  rows.push(wrapCenter(`No. ${data.receiptNumber}`, width));
  rows.push(rule);
  rows.push(`Kasir: ${data.kasirName}`);
  rows.push(`Waktu: ${data.occurredAt}`);
  rows.push(rule);
  for (const line of data.lines) {
    rows.push(`${line.productName}`);
    rows.push(
      padRow(
        `  ${formatQty(line.qty)} x ${formatMoney(line.unitPrice)}`,
        formatMoney(line.lineTotal),
        width,
      ),
    );
  }
  rows.push(rule);
  rows.push(padRow('Subtotal', formatMoney(data.subtotal), width));
  if (data.discount !== '0.00')
    rows.push(padRow('Diskon', `-${formatMoney(data.discount, { withSymbol: false })}`, width));
  rows.push(padRow('TOTAL', formatMoney(data.total), width));
  rows.push(padRow(data.paymentMethodLabel, formatMoney(data.paidAmount), width));
  if (data.changeAmount !== '0.00')
    rows.push(padRow('Kembali', formatMoney(data.changeAmount), width));
  rows.push(rule);
  rows.push(wrapCenter('Terima kasih', width));
  return rows.join('\n');
}

/** Encodes the receipt as raw ESC/POS bytes for a thermal printer. */
export function buildReceiptEscPos(data: ReceiptData): Uint8Array {
  const bytes: number[] = [];
  const push = (...b: number[]) => bytes.push(...b);
  const text = (s: string) => push(...Array.from(new TextEncoder().encode(s + '\n')));

  push(...CMD.INIT, ...CMD.ALIGN_CENTER, ...CMD.BOLD_ON);
  text(data.outletName);
  push(...CMD.BOLD_OFF);
  text(`No. ${data.receiptNumber}`);
  push(...CMD.ALIGN_LEFT);
  text(buildReceiptText(data));
  push(...CMD.FEED(3), ...CMD.CUT);
  return new Uint8Array(bytes);
}

/**
 * Standard Nordic UART-ish ESC/POS BLE profile most 58/80mm mobile thermal
 * printers expose. Some vendors use a different service/characteristic UUID;
 * this is the widely-supported default (used by most "generic ESC/POS BLE"
 * printers sold for POS tablets) — a vendor-specific override can be added
 * later without touching the byte-builder above.
 */
const PRINTER_SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
const PRINTER_CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

export interface BluetoothPrintResult {
  ok: boolean;
  reason?: 'unsupported' | 'cancelled' | 'connection_failed';
  error?: unknown;
}

function hasWebBluetooth(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** The minimal Web Bluetooth surface this module touches — TypeScript's DOM lib doesn't ship `navigator.bluetooth` types. */
interface MinimalBluetoothRemoteCharacteristic {
  writeValue(value: Uint8Array): Promise<void>;
}
interface MinimalBluetoothService {
  getCharacteristic(uuid: string): Promise<MinimalBluetoothRemoteCharacteristic>;
}
interface MinimalBluetoothServer {
  getPrimaryService(uuid: string): Promise<MinimalBluetoothService>;
}
interface MinimalBluetoothDevice {
  gatt?: { connect(): Promise<MinimalBluetoothServer> };
}
interface MinimalBluetooth {
  requestDevice(options: {
    filters: { services: string[] }[];
    optionalServices: string[];
  }): Promise<MinimalBluetoothDevice>;
}

/**
 * Connects to a paired/discoverable BLE thermal printer and prints. Every
 * step degrades gracefully — a tablet without Web Bluetooth (or a user who
 * cancels the device picker) gets `{ ok: false, reason }` rather than a
 * thrown error, so the caller can fall back to `buildReceiptText` for an
 * on-screen "print unavailable, here's the receipt" view.
 */
export async function printReceipt(data: ReceiptData): Promise<BluetoothPrintResult> {
  if (!hasWebBluetooth()) return { ok: false, reason: 'unsupported' };

  try {
    const bt = (navigator as Navigator & { bluetooth: MinimalBluetooth }).bluetooth;
    const device = await bt.requestDevice({
      filters: [{ services: [PRINTER_SERVICE_UUID] }],
      optionalServices: [PRINTER_SERVICE_UUID],
    });
    const server = await device.gatt?.connect();
    if (!server) return { ok: false, reason: 'connection_failed' };
    const service = await server.getPrimaryService(PRINTER_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(PRINTER_CHARACTERISTIC_UUID);

    const payload = buildReceiptEscPos(data);
    // BLE write payloads are typically capped ~20 bytes per ATT MTU without
    // negotiation; chunk conservatively so this works without assuming an
    // extended MTU was negotiated.
    const CHUNK = 180;
    for (let i = 0; i < payload.length; i += CHUNK) {
      await characteristic.writeValue(payload.slice(i, i + CHUNK));
    }
    return { ok: true };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'NotFoundError') return { ok: false, reason: 'cancelled', error };
    return { ok: false, reason: 'connection_failed', error };
  }
}
