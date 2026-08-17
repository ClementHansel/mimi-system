/**
 * The attachment side-channel — SYNC-PROTOCOL §4.7. Binary evidence (wajib
 * foto: FR-LOG-15, FR-WST-01, petty cash, FR-HR-01 selfies, FR-PMS-04, SJ
 * drop photos/signatures, §7 approval selfies) never rides the event stream
 * — it is captured locally, hashed, and embedded as an `attachment_ref` in
 * the OWNING event's payload (see `captureAttachment`'s return value), while
 * the actual bytes upload separately, cloud-direct, whenever WAN is up.
 *
 * "Nodes do not store or relay binaries" (§1.1, §4.7) — this is why upload
 * always targets the CLOUD origin explicitly, never whatever upstream
 * `upstream-selector.ts` currently holds (a node might be the sync upstream
 * while the binary outbox is still cloud-direct-only, or fully paused during
 * a LAN-only period).
 *
 * TWO IDENTITIES, ONE ROW (found by W4-07 wiring outlet receiving — FR-LOG-15
 * wajib foto, the anti-fraud checkpoint on goods receipt): `sha256` is the
 * content-addressed dedupe key; the wire schema an owning event actually
 * embeds wants a UUID (`packages/sync-protocol/src/schema/registry.ts`'s
 * `sj_drops.received.photoAttachmentIds: array(uuid())` /
 * `signatureAttachmentId: uuid()`, same shape for `goods_receipts.recorded`,
 * `waste_records.reported`, petty cash, attendance selfies, §7 approval
 * selfies). Without a stored correlation, a device mints a UUID per capture
 * to satisfy the payload shape and nothing on this device ever maps that id
 * back to the blob — the event ships claiming photographic evidence exists
 * under an id the cloud's `attachments` row was never keyed by. That is
 * worse than no photo requirement: the audit trail LOOKS complete and isn't.
 * `attachmentId` (on `AttachmentRecord`, `../types.ts`) closes this: minted
 * once per distinct `sha256` at first capture, reused on every dedupe hit,
 * returned by `captureAttachment`, looked up by `getAttachmentByAttachmentId`,
 * and carried through `drainAttachmentUploads`/`AttachmentUploader` so the
 * upload request tells the cloud which id its stored row must land under.
 */
import type { LocalDatabase } from '../store/local-database';
import type { AttachmentRecord } from '../types';
import type { UUID } from '@mimi/shared';
import { ATTACHMENT_CAP_BYTES, ATTACHMENT_CAP_COUNT } from '../constants';
import { newUuid } from '../../uuid';

/** Shared `newUuid()` (`lib/uuid.ts`) — `crypto.randomUUID()` when available, a `crypto.getRandomValues`-backed v4 fallback otherwise (insecure-origin-safe; never `Math.random()`). Plain v4 is the right choice here (not `formatUuidV7`): attachment ids carry no ordering meaning, they are pure reference keys. */
function mintAttachmentId(): UUID {
  return newUuid();
}

export class AttachmentCapExceededError extends Error {
  constructor() {
    super('ERR_STORAGE_FULL: attachment cap reached (200MB / 500 blobs) with no uploaded evidence to evict — evidence-requiring action blocked (§4.7/§9 T-09)');
    this.name = 'AttachmentCapExceededError';
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SubtleCrypto is unavailable in this environment');
  const buf = await blob.arrayBuffer();
  const digest = await subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AttachmentRef {
  sha256: string;
  /** The id to put in the owning event's `photoAttachmentIds`/`signatureAttachmentId`/`attachment_ref` field — NOT `sha256` (see this file's header). */
  attachmentId: UUID;
  size: number;
  mime: string;
  kind: string;
}

/**
 * Captures one blob into the local attachment store. Idempotent by
 * content-hash (§4.7 rule 3: "same-sha256 re-upload is a no-op") — capturing
 * the same photo twice is a cheap overwrite, not a duplicate, and returns
 * the SAME `attachmentId` minted on the original capture (one physical blob,
 * one canonical id, however many events end up referencing it).
 *
 * Enforces the cap BEFORE writing: only blobs already `uploaded` (cloud-
 * confirmed) are evictable, oldest first; blobs still `pending` are never
 * evicted (evidence pending upload is never evicted, per spec). If the cap
 * can't be satisfied by evicting uploaded blobs, throws
 * `AttachmentCapExceededError` — the caller (a Wave 4 evidence-capture
 * screen) must surface this as a blocking storage error, never silently
 * drop the requirement (T-09).
 */
export async function captureAttachment(db: LocalDatabase, blob: Blob, mime: string, kind: string): Promise<AttachmentRef> {
  const sha256 = await sha256Hex(blob);
  const store = db.store<AttachmentRecord>('attachments');

  const existing = await store.get(sha256);
  if (existing) return { sha256, attachmentId: existing.attachmentId, size: existing.size, mime: existing.mime, kind: existing.kind };

  const all = await store.getAll();
  const totalBytes = all.reduce((sum, a) => sum + a.size, 0);
  const overBytes = totalBytes + blob.size - ATTACHMENT_CAP_BYTES;
  const overCount = all.length + 1 - ATTACHMENT_CAP_COUNT;

  if (overBytes > 0 || overCount > 0) {
    const evicted = await evictUploaded(store, all, Math.max(overBytes, 0), Math.max(overCount, 0));
    if (!evicted) throw new AttachmentCapExceededError();
  }

  const attachmentId = mintAttachmentId();
  const record: AttachmentRecord = {
    sha256,
    attachmentId,
    blob,
    size: blob.size,
    mime,
    kind,
    capturedAt: new Date().toISOString(),
    uploadStatus: 'pending',
    uploadedAt: null,
  };
  await store.put(record);
  return { sha256, attachmentId, size: blob.size, mime, kind };
}

/**
 * Resolves an event's referenced `attachmentId` back to its stored blob —
 * the exact correlation this file exists to guarantee. No secondary index
 * (consistent with every other store in this package at Tier-1 volumes,
 * `ATTACHMENT_CAP_COUNT` = 500 rows max): a linear scan over `getAll()`.
 */
export async function getAttachmentByAttachmentId(db: LocalDatabase, attachmentId: UUID): Promise<AttachmentRecord | undefined> {
  const all = await db.store<AttachmentRecord>('attachments').getAll();
  return all.find((a) => a.attachmentId === attachmentId);
}

async function evictUploaded(
  store: ReturnType<LocalDatabase['store']>,
  all: AttachmentRecord[],
  neededBytes: number,
  neededSlots: number,
): Promise<boolean> {
  const uploaded = all.filter((a) => a.uploadStatus === 'uploaded').sort((a, b) => (a.uploadedAt ?? '').localeCompare(b.uploadedAt ?? ''));
  let freedBytes = 0;
  let freedSlots = 0;
  for (const a of uploaded) {
    if (freedBytes >= neededBytes && freedSlots >= neededSlots) break;
    await store.delete(a.sha256);
    freedBytes += a.size;
    freedSlots += 1;
  }
  return freedBytes >= neededBytes && freedSlots >= neededSlots;
}

export interface AttachmentUploader {
  /**
   * `attachmentId` is carried through so the cloud's stored row can land
   * under the SAME id the owning event already referenced in
   * `photoAttachmentIds`/`signatureAttachmentId` — not merely under `sha256`.
   */
  upload(sha256: string, attachmentId: UUID, blob: Blob): Promise<void>;
}

/**
 * ASSUMPTION flagged for W2-D reconciliation (same discipline as this
 * package's other wire-contract assumptions, e.g. `offline-credentials.ts`'s
 * token format note): CONTRACTS.md's documented endpoint is `PUT
 * /sync/v1/attachments/:sha256 -> {ok:true, attachmentId:UUID}`, which reads
 * as the CLOUD minting the id and returning it — but the event carrying
 * `photoAttachmentIds`/`signatureAttachmentId` is pushed and may already be
 * APPLIED before the binary ever uploads (§4.7 rule 1: "the event pushes
 * immediately — it never waits for the binary"), so the id in that payload
 * MUST be the device's own, decided at capture time, not something the cloud
 * hands back later. This uploader sends the device's `attachmentId` as an
 * `X-Attachment-Id` header alongside the sha256-addressed URL so the cloud
 * has the correlation available regardless of which side is expected to be
 * authoritative for the id — W2-D's real endpoint should either accept this
 * header as the row's id, or the architect should amend the endpoint
 * response contract to require echoing the SAME id back, never a fresh one.
 */
export function createHttpAttachmentUploader(cloudBaseUrl: string, deviceToken: () => string | null): AttachmentUploader {
  return {
    async upload(sha256, attachmentId, blob) {
      const token = deviceToken();
      const url = `${cloudBaseUrl.replace(/\/$/, '')}/sync/v1/attachments/${sha256}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': blob.type || 'application/octet-stream',
          'X-Attachment-Id': attachmentId,
        },
        body: blob,
      });
      if (!res.ok) throw new Error(`attachment upload failed: HTTP ${res.status}`);
    },
  };
}

/** Drains every `pending` attachment cloud-direct. Best-effort — a failure just leaves it `pending` for the next drain. */
export async function drainAttachmentUploads(db: LocalDatabase, uploader: AttachmentUploader): Promise<{ uploaded: number; failed: number }> {
  const store = db.store<AttachmentRecord>('attachments');
  const pending = (await store.getAll()).filter((a) => a.uploadStatus === 'pending');
  let uploaded = 0;
  let failed = 0;
  for (const a of pending) {
    try {
      await uploader.upload(a.sha256, a.attachmentId, a.blob);
      await store.put({ ...a, uploadStatus: 'uploaded', uploadedAt: new Date().toISOString() });
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }
  return { uploaded, failed };
}
