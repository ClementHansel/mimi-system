import type { PoolClient } from 'pg';
import { formatDeviceDocNumber, formatShiftNumber } from '@mimi/shared';

/**
 * Device-local document numbering (CONTRACTS.md §0, §1.5 of SYNC-PROTOCOL):
 * `sales`/`pos_shifts` are offline-born documents, numbered
 * `<locationCode>-<deviceCode>-<localSeq>` (shifts additionally prefix the
 * sequence with `S`), assigned locally and NEVER renumbered on sync.
 *
 * This module's REST endpoints are the online/apply/test surface (no real
 * device outbox behind them — see `pos.module.ts`'s header), so "local
 * sequence" here is approximated as `COUNT(rows for this location) + 1`,
 * with a bounded retry (via `SAVEPOINT`, since a `23505` unique-violation
 * poisons the rest of the enclosing transaction otherwise) on a collision
 * from two concurrent requests computing the same count — acceptable for
 * the interactive/test surface this endpoint set serves; a genuinely
 * offline device keeps its own durable `clientSeq`-backed counter
 * (SYNC-PROTOCOL §2.2) and this function is never in that path.
 */

const DUPLICATE_KEY_SQLSTATE = '23505';
const MAX_ATTEMPTS = 5;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === DUPLICATE_KEY_SQLSTATE
  );
}

async function withNumberRetry(
  client: PoolClient,
  build: (attempt: number) => string,
  tryInsert: (candidate: string) => Promise<void>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = build(attempt);
    await client.query('SAVEPOINT pos_doc_number');
    try {
      await tryInsert(candidate);
      await client.query('RELEASE SAVEPOINT pos_doc_number');
      return candidate;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT pos_doc_number');
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Failed to allocate a unique document number after retries');
}

/**
 * Allocates the next shift number and, in the SAME savepoint as the
 * caller-supplied insert, so the number that wins is exactly the number
 * stored even under the retry loop.
 */
export async function allocateShiftNumber(
  client: PoolClient,
  locationCode: string,
  deviceCode: string,
  insertWithNumber: (shiftNumber: string) => Promise<void>,
): Promise<string> {
  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM pos_shifts`,
  );
  const base = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);
  return withNumberRetry(
    client,
    (attempt) => formatShiftNumber(locationCode, deviceCode, base + 1 + attempt),
    insertWithNumber,
  );
}

export async function allocateReceiptNumber(
  client: PoolClient,
  locationCode: string,
  deviceCode: string,
  insertWithNumber: (receiptNumber: string) => Promise<void>,
): Promise<string> {
  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM sales`,
  );
  const base = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);
  return withNumberRetry(
    client,
    (attempt) => formatDeviceDocNumber(locationCode, deviceCode, base + 1 + attempt),
    insertWithNumber,
  );
}
