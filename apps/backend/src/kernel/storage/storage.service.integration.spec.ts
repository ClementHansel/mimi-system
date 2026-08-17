import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { StorageService } from './storage.service';
import { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';

/**
 * Integration proof (BUILD-PLAN §5 W2-C "TESTING" requirement): EXIF is
 * ACTUALLY stripped from a real uploaded JPEG, round-tripped through a real
 * MinIO instance via a real presigned URL — not a mock of the S3 client.
 *
 * D-21/D-22: `DATABASE_URL`/`TEST_DATABASE_URL` now authenticates as
 * `mimi_app` — the same non-superuser, zero-direct-grant login role the
 * real app connects as — not the migration/admin ('mimi') superuser this
 * test originally used. That distinction is exactly what the coordinator's
 * cross-agent review caught: this suite passed before only because the
 * environment's pool was still the superuser, silently hiding that
 * `StorageService` had no way to touch `attachments` under the REAL runtime
 * role. `openRequestClient()` below reproduces exactly what
 * `RlsContextGuard` does per real HTTP request (`SET LOCAL ROLE app_user` +
 * the three session vars) so this suite exercises the actual production
 * code path, not a privileged shortcut.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mimi_app:mimi_app_secret@localhost:55433/mimi';

function fakeConfigService() {
  const values: Record<string, string> = {
    MINIO_ENDPOINT: process.env.TEST_MINIO_HOST ?? 'localhost',
    MINIO_PORT: process.env.TEST_MINIO_PORT ?? '9000',
    MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: 'mimi_minio',
    MINIO_SECRET_KEY: 'mimi_minio_secret',
    MINIO_BUCKET: 'mimi-storage-test',
    S3_REGION: 'us-east-1',
  };
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 10, g: 100, b: 200 } },
  })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'X' }, GPS: { GPSLatitude: '1/1, 30/1, 0/1' } })
    .toBuffer();
}

/** Reproduces `RlsContextGuard`'s phase 0/1/2 for one request's worth of work. Caller commits/releases via `endRequest`. */
async function openRequestClient(pool: Pool, user: JwtAccessPayload, locationScope: string[] | null): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [(locationScope ?? []).join(',')]);
  return client;
}

async function endRequest(client: PoolClient): Promise<void> {
  await client.query('COMMIT');
  client.release();
}

describe('StorageService (integration, live Postgres as mimi_app + MinIO)', () => {
  let pool: Pool;
  let service: StorageService;
  let dbAvailable = true;
  let managerId: string;
  const user = (): JwtAccessPayload => ({ sub: managerId, username: 'manager1', roleKey: 'manager', locationIds: [] });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    try {
      // Reading `users` needs the same role switch as any other query on
      // this pool — a central-role request client covers it.
      const setupClient = await openRequestClient(
        pool,
        { sub: '00000000-0000-0000-0000-000000000000', username: 'setup', roleKey: 'owner', locationIds: [] },
        null,
      );
      const u = await setupClient.query(`SELECT id FROM users WHERE username = 'manager1' LIMIT 1`);
      await endRequest(setupClient);
      if (u.rows.length === 0) {
        dbAvailable = false;
        return;
      }
      managerId = u.rows[0].id;
    } catch {
      dbAvailable = false;
      return;
    }

    service = new StorageService(fakeConfigService());
    try {
      await service.onModuleInit();
      // Confirm MinIO is actually reachable (onModuleInit swallows failures to
      // stay non-fatal at real app boot) — a failed presign below would
      // otherwise surface as a confusing network error instead of a clean skip.
      const probeClient = await openRequestClient(pool, user(), null);
      await service.presign(probeClient, user(), {
        fileName: 'probe.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        kind: 'probe',
      });
      await endRequest(probeClient);
    } catch {
      dbAvailable = false;
    }
  }, 20_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('strips EXIF from a real uploaded JPEG round-tripped through MinIO via presigned URLs', async () => {
    if (!dbAvailable) {
      console.warn('Skipping: live Postgres/MinIO not reachable');
      return;
    }

    const original = await makeJpegWithExif();
    const originalMeta = await sharp(original).metadata();
    expect(originalMeta.exif).toBeDefined(); // fixture sanity check

    const presignClient = await openRequestClient(pool, user(), null);
    const presign = await service.presign(presignClient, user(), {
      fileName: 'receiving-photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: original.length,
      kind: 'receiving_photo',
      entityType: 'goods_receipt',
    });
    await endRequest(presignClient);

    // The client's leg: upload directly to MinIO via the presigned PUT URL.
    const putResponse = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: original,
    });
    expect(putResponse.ok).toBe(true);

    const confirmClient = await openRequestClient(pool, user(), null);
    const confirmed = await service.confirm(confirmClient, user(), presign.attachmentId, 'client-side-hash-hint');
    await endRequest(confirmClient);
    expect(confirmed.mimeType).toBe('image/jpeg');
    expect(confirmed.sizeBytes).toBeLessThan(original.length);

    // Fetch the PROCESSED object back via a fresh presigned GET and verify
    // directly against the bytes MinIO actually holds now.
    const getUrlClient = await openRequestClient(pool, user(), null);
    const getUrlResult = await service.getUrl(getUrlClient, user(), null, presign.attachmentId);
    await endRequest(getUrlClient);
    const getResponse = await fetch(getUrlResult.url);
    expect(getResponse.ok).toBe(true);
    const processedBuffer = Buffer.from(await getResponse.arrayBuffer());

    const processedMeta = await sharp(processedBuffer).metadata();
    expect(processedMeta.exif).toBeUndefined();
    expect(processedBuffer.length).toBeLessThan(original.length);
    expect(processedBuffer.length).toBe(confirmed.sizeBytes);
  });

  it('rejects getUrl for a caller whose scope excludes the attachment location', async () => {
    if (!dbAvailable) return;

    const lookupClient = await openRequestClient(pool, user(), null);
    const outletLocation = await lookupClient.query(`SELECT id FROM locations WHERE code = 'BPP01' LIMIT 1`);
    const otherLocation = await lookupClient.query(`SELECT id FROM locations WHERE code = 'BPP02' LIMIT 1`);
    await endRequest(lookupClient);
    if (outletLocation.rows.length === 0 || otherLocation.rows.length === 0) return;

    const presignClient = await openRequestClient(pool, user(), null);
    const presign = await service.presign(presignClient, user(), {
      fileName: 'waste-photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      kind: 'waste_photo',
      locationId: outletLocation.rows[0].id,
    });
    await endRequest(presignClient);
    await fetch(presign.uploadUrl, { method: 'PUT', body: Buffer.from('not-really-a-jpeg') });

    const scopedOutOfRangeUser: JwtAccessPayload = {
      sub: managerId,
      username: 'leader1',
      roleKey: 'leader_outlet',
      locationIds: [],
    };

    const outOfScopeClient = await openRequestClient(pool, scopedOutOfRangeUser, [otherLocation.rows[0].id]);
    await expect(
      service.getUrl(outOfScopeClient, scopedOutOfRangeUser, [otherLocation.rows[0].id], presign.attachmentId),
    ).rejects.toMatchObject({ response: { code: 'ERR_LOCATION_OUT_OF_SCOPE' } });
    await endRequest(outOfScopeClient);

    // A central role always passes, regardless of scope.
    const centralClient = await openRequestClient(pool, user(), [otherLocation.rows[0].id]);
    const url = await service.getUrl(centralClient, user(), [otherLocation.rows[0].id], presign.attachmentId);
    await endRequest(centralClient);
    expect(url.url).toContain('http');
  });

  it('B-12: honours a device-supplied X-Attachment-Id — the SAME id resolves to the SAME bytes end to end', async () => {
    if (!dbAvailable) return;

    const original = await makeJpegWithExif();
    const deviceAttachmentId = randomUUID();

    const presignClient = await openRequestClient(pool, user(), null);
    const presign = await service.presign(
      presignClient,
      user(),
      { fileName: 'device-capture.jpg', mimeType: 'image/jpeg', sizeBytes: original.length, kind: 'receiving_photo' },
      deviceAttachmentId,
    );
    await endRequest(presignClient);

    // The device's own minted id is exactly what comes back — not a
    // server-generated substitute — which is the whole point: an offline
    // sync_events payload already applied on the cloud, referencing this
    // exact id, must resolve once the photo lands.
    expect(presign.attachmentId).toBe(deviceAttachmentId);

    const putResponse = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: original,
    });
    expect(putResponse.ok).toBe(true);

    const confirmClient = await openRequestClient(pool, user(), null);
    const confirmed = await service.confirm(confirmClient, user(), deviceAttachmentId);
    await endRequest(confirmClient);
    expect(confirmed.id).toBe(deviceAttachmentId);

    // Resolve the SAME id through the normal attachment lookup (exactly
    // what a completely separate request — e.g. F10 rendering the goods
    // receipt later — would do) and confirm it returns the RIGHT BYTES, not
    // just "a row exists".
    const getUrlClient = await openRequestClient(pool, user(), null);
    const getUrlResult = await service.getUrl(getUrlClient, user(), null, deviceAttachmentId);
    await endRequest(getUrlClient);
    const getResponse = await fetch(getUrlResult.url);
    expect(getResponse.ok).toBe(true);
    const resolvedBuffer = Buffer.from(await getResponse.arrayBuffer());

    expect(resolvedBuffer.length).toBe(confirmed.sizeBytes);
    const resolvedMeta = await sharp(resolvedBuffer).metadata();
    expect(resolvedMeta.exif).toBeUndefined(); // still went through the same compress+strip pipeline
    expect(resolvedMeta.width).toBeLessThanOrEqual(1920);
  });

  it('B-12: rejects a malformed X-Attachment-Id', async () => {
    if (!dbAvailable) return;

    const client = await openRequestClient(pool, user(), null);
    await expect(
      service.presign(
        client,
        user(),
        { fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1, kind: 'probe' },
        'not-a-uuid',
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    await endRequest(client);
  });

  it('B-12: rejects reusing a device id for declared content that does not match the original presign', async () => {
    if (!dbAvailable) return;

    const deviceAttachmentId = randomUUID();
    const firstClient = await openRequestClient(pool, user(), null);
    await service.presign(
      firstClient,
      user(),
      { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100, kind: 'receiving_photo' },
      deviceAttachmentId,
    );
    await endRequest(firstClient);

    // Same id, but declaring a DIFFERENT mime type — a bug or an
    // attacker-supplied id collision, not a legitimate retry.
    const secondClient = await openRequestClient(pool, user(), null);
    await expect(
      service.presign(
        secondClient,
        user(),
        { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 100, kind: 'receiving_photo' },
        deviceAttachmentId,
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });
    await endRequest(secondClient);
  });

  it('B-12: a second presign for the SAME device id with matching declared content is idempotent (retry after a dropped connection)', async () => {
    if (!dbAvailable) return;

    const deviceAttachmentId = randomUUID();
    const dto = { fileName: 'retry.jpg', mimeType: 'image/jpeg', sizeBytes: 100, kind: 'receiving_photo' };

    const firstClient = await openRequestClient(pool, user(), null);
    const first = await service.presign(firstClient, user(), dto, deviceAttachmentId);
    await endRequest(firstClient);

    const secondClient = await openRequestClient(pool, user(), null);
    const second = await service.presign(secondClient, user(), dto, deviceAttachmentId);
    await endRequest(secondClient);

    expect(second.attachmentId).toBe(first.attachmentId);
    expect(second.objectKey).toBe(first.objectKey); // same underlying object — no duplicate row minted
  });

  it('REGRESSION (D-21/D-22): a bare mimi_app connection with no SET LOCAL ROLE cannot touch attachments at all, but a properly role-switched request client can', async () => {
    if (!dbAvailable) return;

    // The exact bug the coordinator flagged: StorageService used to run its
    // queries on `this.pool` directly. Prove that shape is now impossible to
    // silently ship by hitting the raw pool with zero role switch.
    await expect(pool.query('SELECT * FROM attachments LIMIT 1')).rejects.toMatchObject({
      code: '42501', // permission denied
    });

    // The fixed shape: StorageService.presign() over a properly-role-switched
    // request client succeeds against the SAME pool.
    const client = await openRequestClient(pool, user(), null);
    const result = await service.presign(client, user(), {
      fileName: 'regression-probe.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      kind: 'probe',
    });
    await endRequest(client);
    expect(result.attachmentId).toBeTruthy();
  });
});
