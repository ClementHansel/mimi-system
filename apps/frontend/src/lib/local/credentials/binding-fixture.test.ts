import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeBindingHmac } from './offline-credentials';

/**
 * Golden fixture for the §7.3 binding HMAC — fixed (key, inputs) -> expected
 * hex digest, computed INDEPENDENTLY of this file's own implementation (via
 * plain Node `crypto.createHmac`, mirroring `apps/backend/src/kernel/sync/
 * binding-crypto.ts`'s `bindingMessage`/`computeBindingHmac` exactly: the
 * U+2016 `‖` joiner, and `amountIdr` passed as an already-normalized string
 * with no internal `?? ''`).
 *
 * This is the test that would have caught the joiner mismatch (`|` vs `‖`)
 * before it shipped: two implementations "agreeing" only by both citing the
 * same prose spec is exactly how that broke. A reference digest computed
 * independently — via Node's built-in `crypto`, not this module's own
 * Web-Crypto code path — is something a divergence on either side cannot
 * silently drift past.
 */
describe('binding HMAC — golden fixture (SYNC-PROTOCOL §7.3, backend parity)', () => {
  // 32 bytes of 0x09, base64-encoded — an arbitrary but FIXED key so the reference digest is reproducible.
  const K_RAW = Buffer.alloc(32, 9);
  const K_BASE64 = K_RAW.toString('base64');

  /** Independent reference implementation — Node's `crypto`, byte-for-byte the backend's `bindingMessage`/`computeBindingHmac`. */
  function referenceHmac(fields: {
    eventId: string;
    entity: string;
    entityId: string;
    op: string;
    amountIdr: string;
    occurredAt: string;
  }): string {
    const message = [
      fields.eventId,
      fields.entity,
      fields.entityId,
      fields.op,
      fields.amountIdr,
      fields.occurredAt,
    ].join('‖');
    return createHmac('sha256', K_RAW).update(message, 'utf8').digest('hex');
  }

  const withAmountFields = {
    eventId: '018e5f2a-1b2c-7000-8000-000000000001',
    entity: 'void_refunds',
    entityId: '018e5f2a-1b2c-7000-8000-000000000002',
    op: 'approved_offline',
    amountIdr: '150000.00',
    occurredAt: '2026-08-17T03:00:00.000Z',
  };

  const noAmountFields = {
    eventId: '018e5f2a-1b2c-7000-8000-000000000003',
    entity: 'waste_records',
    entityId: '018e5f2a-1b2c-7000-8000-000000000004',
    op: 'approved_offline',
    amountIdr: '', // normalized from `null` at the `authorizeOffline` call site, per the backend's contract
    occurredAt: '2026-08-17T04:00:00.000Z',
  };

  it('matches the independently-computed reference digest for a WITH-amount action', async () => {
    const digest = await computeBindingHmac(K_BASE64, withAmountFields);
    expect(digest).toHaveLength(64);
    expect(digest).toBe(referenceHmac(withAmountFields));
    // Pinned literal (regenerate only if the message format deliberately changes — never to "make the test pass"):
    expect(digest).toBe('fe605bdba23786e294b768710805dcb7811e74d6ba90d154fb4d5481c3b22d36');
  });

  it('matches the independently-computed reference digest for a NO-amount action', async () => {
    const digest = await computeBindingHmac(K_BASE64, noAmountFields);
    expect(digest).toHaveLength(64);
    expect(digest).toBe(referenceHmac(noAmountFields));
    expect(digest).toBe('659a63029ed60b3480383fc5467cf8d1b7ff895b977a8121c8e67e5efdf6b5c3');
  });

  it('regression guard: the joiner is U+2016 (DOUBLE VERTICAL LINE), not U+007C (a plain pipe) — the exact bug that shipped', () => {
    const wrongJoinerMessage = [
      withAmountFields.eventId,
      withAmountFields.entity,
      withAmountFields.entityId,
      withAmountFields.op,
      withAmountFields.amountIdr,
      withAmountFields.occurredAt,
    ].join('|');
    const wrongDigest = createHmac('sha256', K_RAW)
      .update(wrongJoinerMessage, 'utf8')
      .digest('hex');
    expect(wrongDigest).not.toBe(referenceHmac(withAmountFields));
  });
});
