/**
 * Document-numbering formats (CONTRACTS.md §0).
 *
 * Cloud-issued: `<PREFIX>/<YYYYMM>/<seq>` (e.g. `SJ/202608/0042`) — assigned by
 * `document_counters`, never renumbered.
 * Device-born (offline-capable documents: sales, shifts): `<locationCode>-
 * <deviceCode>-<localSeq>` — assigned locally, final, and never renumbered on
 * sync (renumbering a printed receipt is itself a fraud surface, SYNC-PROTOCOL §1.5).
 */

const CLOUD_DOC_NUMBER_RE = /^([A-Z]+)\/(\d{6})\/(\d+)$/;

export function formatCloudDocNumber(
  prefix: string,
  periodYYYYMM: string,
  seq: number,
  pad = 4,
): string {
  if (!/^\d{6}$/.test(periodYYYYMM)) {
    throw new RangeError(`period must be 'YYYYMM', got ${JSON.stringify(periodYYYYMM)}`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`seq must be a non-negative integer, got ${seq}`);
  }
  return `${prefix}/${periodYYYYMM}/${String(seq).padStart(pad, '0')}`;
}

export function parseCloudDocNumber(
  docNumber: string,
): { prefix: string; period: string; seq: number } | null {
  const match = CLOUD_DOC_NUMBER_RE.exec(docNumber);
  if (!match) return null;
  const [, prefix, period, seqStr] = match;
  return { prefix: prefix!, period: period!, seq: Number.parseInt(seqStr!, 10) };
}

/** Device-born document number, e.g. a POS receipt or shift number. */
export function formatDeviceDocNumber(
  locationCode: string,
  deviceCode: string,
  localSeq: number,
): string {
  if (!Number.isInteger(localSeq) || localSeq < 1) {
    throw new RangeError(`localSeq must be a positive integer, got ${localSeq}`);
  }
  return `${locationCode}-${deviceCode}-${localSeq}`;
}

/** POS shift number specifically prefixes the local sequence with `S` per CONTRACTS.md §1.6. */
export function formatShiftNumber(
  locationCode: string,
  deviceCode: string,
  localSeq: number,
): string {
  return formatDeviceDocNumber(locationCode, deviceCode, localSeq).replace(
    /-(\d+)$/,
    (_m, n: string) => `-S${n}`,
  );
}
