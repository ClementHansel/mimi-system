import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  CopyObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PoolClient } from 'pg';
import { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import {
  compressAndStripExif,
  isProcessableImage,
  makeThumbnail,
  sha256Hex,
} from './image-processing.util';
import { withWrite } from './db-tx';

const PRESIGN_UPLOAD_TTL_SECONDS = 15 * 60; // 15 minutes to complete an upload
const PRESIGN_DOWNLOAD_TTL_SECONDS = 10 * 60; // 10 minutes to view/download

/** RFC 4122 UUID, any version — device-supplied ids (`X-Attachment-Id`) are attacker-influenceable input and must be validated, not just trusted as "a string". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CONTRACTS.md §1.14: roles whose scope spans every location — never blocked by an attachment's `location_id`. */
const CENTRAL_ROLES = new Set(['owner', 'manager', 'finance', 'hr_admin']);

/** Drains an S3 object body into one Buffer. */
async function collectStream(body: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export interface PresignRequest {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  entityType?: string;
  entityId?: string;
  locationId?: string;
}

export interface PresignResult {
  attachmentId: string;
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  url: string;
}

interface AttachmentRow {
  id: string;
  bucket: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  entity_type: string | null;
  entity_id: string | null;
  kind: string;
  location_id: string | null;
  uploaded_by: string | null;
}

/**
 * `StorageService` — MinIO (S3-API) object storage + the `attachments` table
 * (kernel/storage, BUILD-PLAN §5 W2-C). Backs every *wajib foto* flow:
 * receiving, waste, petty cash, payment proof, absensi selfie, servis, and
 * Surat Jalan drops (CONTRACTS.md §0).
 *
 * UPLOAD FLOW (matches CONTRACTS.md §4.0's three endpoints):
 * 1. `presign()` — the caller declares fileName/mimeType/sizeBytes/kind up
 *    front (all NOT NULL on `attachments`), so the row is inserted HERE,
 *    immediately, with a fresh unique `object_key`; a presigned S3 `PUT` URL
 *    is returned for the CLIENT to upload directly to MinIO (the backend
 *    never proxies the raw bytes on this leg — NFR-09, avoids doubling
 *    upload bandwidth through the API process).
 *
 *    DEVICE-MINTED IDS (`X-Attachment-Id`, B-12 cross-tier fix): an offline
 *    capture mints its own `attachmentId` at capture time, before the photo
 *    ever uploads — an offline goods-receipt event can apply on the cloud
 *    (via `sync_events`) referencing that id BEFORE the binary drains from
 *    the device's outbox, so the id cannot wait to be minted at upload
 *    time (the applied event would point at nothing, then at a DIFFERENT
 *    id once upload finally happened). `presign()` therefore accepts an
 *    OPTIONAL caller-supplied id (`clientAttachmentId`): validated as a
 *    well-formed UUID, honoured as `attachments.id` instead of a
 *    server-minted one when present. A browser using the plain online
 *    presign flow (no header) is unaffected — it gets a server-minted id
 *    exactly as before. A SECOND presign for the SAME device-minted id
 *    (an offline retry after a dropped connection) is idempotent PROVIDED
 *    the declared `mimeType`/`kind` still match what was declared the first
 *    time; a mismatch means the id has been reused for a logically
 *    different attachment and is rejected (`ERR_CONFLICT`) — a
 *    device-supplied primary key is attacker-influenceable input, treated
 *    as such.
 * 2. `confirm()` — the client calls this after its direct PUT succeeds.
 *    THIS is where the backend actually touches the bytes: it downloads
 *    the just-uploaded object, and if it is a compressible image
 *    (`image-processing.util.ts`), compresses it AND strips EXIF, then
 *    re-uploads the processed bytes over the same key. `attachments.sha256`
 *    and `.size_bytes` are updated to reflect the PROCESSED bytes (the
 *    caller's own `sha256` of what it uploaded is accepted as an integrity
 *    hint but not trusted as the final hash — the server-computed one after
 *    processing is authoritative for `AttachmentDto`/audit purposes). A
 *    non-image attachment (e.g. a generated PDF) is left untouched, just
 *    confirmed to exist.
 *
 *    `sha256` REMAINS THE DEDUPE KEY even with device-minted ids: two
 *    different `attachmentId`s are two different rows (each needs its own
 *    unique `object_key` — `attachments.object_key` is `UNIQUE`), but if
 *    their PROCESSED bytes hash identically, the second `confirm()` copies
 *    the FIRST row's already-processed object onto its own key server-side
 *    (`CopyObjectCommand`, no re-download/re-compress/re-upload) instead of
 *    redundantly reprocessing byte-identical content — one blob, two
 *    catalogue entries, which is what "the ids serve different purposes"
 *    means: identity of the *reference* vs. identity of the *bytes*.
 *    A SECOND `confirm()` for the SAME `attachmentId` (a retried offline
 *    sync) is idempotent when the recomputed hash matches what is already
 *    stored; if it does NOT match, that id has ended up bound to two
 *    different sets of bytes across two attempts — a real integrity
 *    violation, rejected (`ERR_CONFLICT`) rather than silently overwritten.
 * 3. `getUrl()` — issues a fresh presigned GET, after an entity-scope check:
 *    an attachment with a `location_id` set is only servable to a central
 *    role (CONTRACTS.md §1.14 `app_is_central()`) or a caller whose resolved
 *    `locationScope` includes it — RLS does not cover `attachments`
 *    (migration 009: "NO RLS ... API-guarded only"), so this check is the
 *    entire enforcement for that table.
 *
 * D-21/D-22: `DATABASE_POOL` connects as `mimi_app`, which holds NO table
 * grants of its own — a bare query on a fresh connection from that pool
 * fails `permission denied` on every statement until `SET LOCAL ROLE
 * app_user` runs on that same transaction. Every method below therefore
 * takes the CALLER's own `PoolClient` (`request.dbClient`, already given
 * that role switch by `RlsContextGuard` — the same pattern
 * `modules/location/request-db-client.ts` established) rather than holding
 * its own `Pool` — every current call site is a `StorageController`
 * endpoint, which always runs behind a non-`@Public()` guard chain and so
 * always has one. `attachments` itself carries no RLS policy (see
 * `getUrl()`'s doc below), so the role switch alone is sufficient; no
 * `app.*` session var is required for these queries specifically.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  /** Server-side object operations — reaches MinIO on the container network. */
  private readonly client: S3Client;
  /**
   * Signs URLs that a BROWSER OR PHONE will open. Same credentials, different
   * host, and it must be a separate client: SigV4 signs the host and path, so a
   * URL signed for `minio:9000` and then opened against a public address fails
   * the signature check rather than merely being unreachable.
   *
   * Falls back to `client` when no public endpoint is configured, which is the
   * correct behaviour for local development where `localhost:9000` is already
   * the address both sides use.
   */
  private readonly signingClient: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('MINIO_ENDPOINT', 'localhost');
    const port = this.config.get<string>('MINIO_PORT', '9000');
    const ssl = String(this.config.get('MINIO_USE_SSL', 'false')).toLowerCase() === 'true';
    const endpoint =
      this.config.get<string>('S3_ENDPOINT') ?? `${ssl ? 'https' : 'http'}://${host}:${port}`;
    this.bucket = this.config.get<string>('MINIO_BUCKET', 'mimi-storage');

    // `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` is what `.env` and
    // `docker-compose.yml` actually define; `MINIO_ACCESS_KEY`/`_SECRET_KEY` is
    // what compose then maps them onto for this service. Reading only the
    // latter meant that running the backend OUTSIDE compose (`pnpm dev`) built
    // an S3 client with empty credentials — every presigned URL came back with
    // an empty `X-Amz-Credential` and MinIO answered 400, so no photo could be
    // uploaded in local development and nothing said why.
    const credentials = {
      accessKeyId:
        this.config.get<string>('MINIO_ACCESS_KEY') ??
        this.config.get<string>('MINIO_ROOT_USER', ''),
      secretAccessKey:
        this.config.get<string>('MINIO_SECRET_KEY') ??
        this.config.get<string>('MINIO_ROOT_PASSWORD', ''),
    };
    const region = this.config.get<string>('S3_REGION', 'us-east-1');

    this.client = new S3Client({ region, endpoint, forcePathStyle: true, credentials });

    // The address a device can actually reach. On the VPS the internal endpoint
    // is `http://minio:9000`, which a phone cannot resolve and which a page
    // served over HTTPS would refuse as mixed content — so uploads were
    // impossible on the deployed box even though `presign` returned 200.
    //
    // It must be an ORIGIN, not a path prefix: SigV4 signs the canonical URI, so
    // a proxy that strips `/s3` gives MinIO a different path than was signed and
    // the request fails. Hence a dedicated port in front of MinIO rather than a
    // sub-path on the app's own port (`infrastructure/tls/nginx-tls.conf`).
    const publicEndpoint = this.config.get<string>('S3_PUBLIC_ENDPOINT');
    this.signingClient = publicEndpoint
      ? new S3Client({ region, endpoint: publicEndpoint, forcePathStyle: true, credentials })
      : this.client;

    this.logger.log(
      `Object storage configured: endpoint=${endpoint} bucket=${this.bucket}` +
        (publicEndpoint
          ? ` presigned-url host=${publicEndpoint}`
          : ' presigned URLs use the internal endpoint (set S3_PUBLIC_ENDPOINT for a device-reachable one)'),
    );
    if (!credentials.accessKeyId) {
      this.logger.warn(
        'No object-storage credentials found (MINIO_ACCESS_KEY / MINIO_ROOT_USER are both unset) — every presigned URL will be rejected by the storage server.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket "${this.bucket}"`);
      } catch (err) {
        this.logger.warn(
          `Could not confirm/create bucket "${this.bucket}" at startup (will retry lazily on first use): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private buildObjectKey(kind: string, entityType: string | undefined, fileName: string): string {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
    const prefix = [kind, entityType].filter(Boolean).join('/');
    return `${prefix ? prefix + '/' : ''}${randomUUID()}-${safeName}`;
  }

  /**
   * Wrapped in `withWrite` because it INSERTS the `attachments` row.
   *
   * It was not, and that was a data-loss bug of the kind this codebase already
   * has a guard for: `RlsCleanupInterceptor` rolls back any request that never
   * committed, so the row vanished while the caller still received a 200 and a
   * working upload URL. The bytes then landed in MinIO and `confirm` failed
   * with "attachment not found" — which is every attendance check-in (selfie
   * mandatory) and every waste record (photo mandatory). See `./db-tx.ts`.
   */
  async presign(
    client: PoolClient,
    user: JwtAccessPayload,
    dto: PresignRequest,
    clientAttachmentId?: string,
  ): Promise<PresignResult> {
    return withWrite(client, () => this.presignInTx(client, user, dto, clientAttachmentId));
  }

  private async presignInTx(
    client: PoolClient,
    user: JwtAccessPayload,
    dto: PresignRequest,
    clientAttachmentId?: string,
  ): Promise<PresignResult> {
    if (clientAttachmentId !== undefined && !UUID_RE.test(clientAttachmentId)) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'X-Attachment-Id must be a well-formed UUID',
      });
    }

    if (clientAttachmentId !== undefined) {
      const existing = await client.query<AttachmentRow>(
        'SELECT * FROM attachments WHERE id = $1',
        [clientAttachmentId],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0]!;
        // Same id, different declared content: an offline device reusing an
        // id for a logically different attachment (bug or attacker-supplied
        // collision), not a legitimate retry. Reject rather than silently
        // re-presigning over someone else's evidence photo.
        if (row.mime_type !== dto.mimeType || row.kind !== dto.kind) {
          throw new ConflictException({
            code: 'ERR_CONFLICT',
            message: 'Attachment id already used for different content',
          });
        }
        // Legitimate retry (e.g. a dropped connection before the device's
        // upload completed) — idempotent: re-presign the SAME object key
        // rather than minting a second row for the same capture.
        const retryUploadUrl = await getSignedUrl(
          this.signingClient,
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: row.object_key,
            ContentType: dto.mimeType,
          }),
          { expiresIn: PRESIGN_UPLOAD_TTL_SECONDS },
        );
        return {
          attachmentId: row.id,
          uploadUrl: retryUploadUrl,
          objectKey: row.object_key,
          expiresAt: new Date(Date.now() + PRESIGN_UPLOAD_TTL_SECONDS * 1000).toISOString(),
        };
      }
    }

    const attachmentId = clientAttachmentId ?? randomUUID();
    const objectKey = this.buildObjectKey(dto.kind, dto.entityType, dto.fileName);

    await client.query(
      `INSERT INTO attachments
         (id, bucket, object_key, file_name, mime_type, size_bytes, entity_type, entity_id, kind, location_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        attachmentId,
        this.bucket,
        objectKey,
        dto.fileName,
        dto.mimeType,
        dto.sizeBytes,
        dto.entityType ?? null,
        dto.entityId ?? null,
        dto.kind,
        dto.locationId ?? null,
        user.sub,
      ],
    );

    const uploadUrl = await getSignedUrl(
      this.signingClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: dto.mimeType }),
      { expiresIn: PRESIGN_UPLOAD_TTL_SECONDS },
    );

    return {
      attachmentId,
      uploadUrl,
      objectKey,
      expiresAt: new Date(Date.now() + PRESIGN_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  private async findAttachment(client: PoolClient, id: string): Promise<AttachmentRow> {
    const result = await client.query<AttachmentRow>('SELECT * FROM attachments WHERE id = $1', [
      id,
    ]);
    if (result.rows.length === 0) {
      throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Attachment ${id} not found` });
    }
    return result.rows[0]!;
  }

  /**
   * Also wrapped: the image path UPDATEs `attachments` with the post-processing
   * mime type, size and sha256. Same missing-COMMIT bug as `presign` — a
   * confirmed photo would report a hash the row did not keep.
   *
   * The transaction does span the S3 round trip, which is not free. It is still
   * the right trade: the alternative is committing the row before the object is
   * known to exist, which is the failure mode that produces an attachment
   * pointing at nothing.
   */
  async confirm(
    client: PoolClient,
    user: JwtAccessPayload,
    id: string,
    sha256Hint?: string,
  ): Promise<AttachmentDto> {
    return withWrite(client, () => this.confirmInTx(client, user, id, sha256Hint));
  }

  private async confirmInTx(
    client: PoolClient,
    user: JwtAccessPayload,
    id: string,
    sha256Hint?: string,
  ): Promise<AttachmentDto> {
    void sha256Hint; // Accepted as an integrity hint from the client; the server-computed hash after processing is authoritative.
    const row = await this.findAttachment(client, id);

    // Only the uploader (or a central role) may confirm — presign() records
    // `uploaded_by` at request time specifically to make this check
    // possible; without it, any authenticated caller who guessed/observed an
    // attachmentId could trigger server-side processing on someone else's
    // pending upload.
    if (row.uploaded_by !== user.sub && !CENTRAL_ROLES.has(user.roleKey)) {
      throw new ForbiddenException({
        code: 'ERR_FORBIDDEN',
        message: 'Only the uploader may confirm this attachment',
      });
    }

    if (isProcessableImage(row.mime_type)) {
      const original = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: row.object_key }),
      );
      const originalBuffer = await collectStream(original.Body as AsyncIterable<Buffer>);

      const processed = await compressAndStripExif(originalBuffer);

      // A prior confirm() already recorded a DIFFERENT hash for this exact
      // id — the id has ended up bound to two different sets of bytes
      // across two attempts. Reject rather than silently overwrite evidence.
      if (row.sha256 && row.sha256 !== processed.sha256) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: 'Attachment was already confirmed with different content',
        });
      }

      if (row.sha256 !== processed.sha256) {
        // Cross-attachment dedupe (sha256 remains the dedupe key): if ANOTHER
        // attachment's processed bytes already hash identically, copy that
        // object server-side rather than re-uploading byte-identical
        // content under our own key — one blob, two catalogue entries.
        const twin = await client.query<{ object_key: string }>(
          `SELECT object_key FROM attachments WHERE sha256 = $1 AND id != $2 LIMIT 1`,
          [processed.sha256, id],
        );

        if (twin.rows.length > 0) {
          await this.client.send(
            new CopyObjectCommand({
              Bucket: this.bucket,
              CopySource: `${this.bucket}/${encodeURIComponent(twin.rows[0]!.object_key)}`,
              Key: row.object_key,
              ContentType: processed.mimeType,
            }),
          );
        } else {
          await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: row.object_key,
              Body: processed.buffer,
              ContentType: processed.mimeType,
            }),
          );
        }

        await client.query(
          'UPDATE attachments SET mime_type = $1, size_bytes = $2, sha256 = $3 WHERE id = $4',
          [processed.mimeType, processed.sizeBytes, processed.sha256, id],
        );
        row.mime_type = processed.mimeType;
        row.size_bytes = String(processed.sizeBytes);
        row.sha256 = processed.sha256;
      }
      // else: idempotent re-confirm with identical content — row already reflects it, nothing to do.
    } else {
      // Non-image (e.g. a generated PDF, `slip_pdf`/`sj_pdf` kinds) — verify
      // the object actually landed, but never re-encode a document.
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: row.object_key }));
    }

    const url = await getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: row.object_key }),
      {
        expiresIn: PRESIGN_DOWNLOAD_TTL_SECONDS,
      },
    );

    return this.toDto(row, url);
  }

  async getUrl(
    client: PoolClient,
    user: JwtAccessPayload,
    locationScope: string[] | null,
    id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const row = await this.findAttachment(client, id);
    this.assertEntityScope(user, locationScope, row);

    const url = await getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: row.object_key }),
      {
        expiresIn: PRESIGN_DOWNLOAD_TTL_SECONDS,
      },
    );
    return {
      url,
      expiresAt: new Date(Date.now() + PRESIGN_DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * `attachments` carries no RLS (migration 009 §1.14 "NONE" group) — this
   * is the entire enforcement. A central role (owner/manager/finance/
   * hr_admin) always passes; anyone else must have the attachment's
   * `location_id` (when set) within their resolved `locationScope`
   * (`null` = unrestricted, e.g. RlsContextGuard couldn't resolve one —
   * treated as central-equivalent since that only happens for central
   * roles per `ScopeService`). An attachment with no `location_id` at all
   * (e.g. a menu product photo) is visible to anyone authenticated.
   */
  private assertEntityScope(
    user: JwtAccessPayload,
    locationScope: string[] | null,
    row: AttachmentRow,
  ): void {
    if (!row.location_id) return;
    if (CENTRAL_ROLES.has(user.roleKey)) return;
    if (locationScope === null) return;
    if (locationScope.includes(row.location_id)) return;
    throw new ForbiddenException({
      code: 'ERR_LOCATION_OUT_OF_SCOPE',
      message: 'Attachment belongs to a location outside your scope',
    });
  }

  /**
   * Bytes of a small WebP thumbnail of an image attachment, generated on first
   * request and cached in the bucket alongside the original.
   *
   * WHY BYTES AND NOT A PRESIGNED URL: `getUrl()` mints a URL that expires in
   * 10 minutes, which is fine for a form the user is looking at right now and
   * useless for the POS menu — `PosCatalogService` precaches the catalog onto
   * every tablet and serves it offline for as long as the device stays offline,
   * so an expiring URL would break exactly when the outlet needs it. That
   * service's header called this out as a known follow-up. Serving the bytes
   * through the API instead gives a STABLE, auth-checked address the till can
   * fetch once and keep in IndexedDB.
   *
   * WRITE-THROUGH CACHE: the resize runs at most once per attachment per size
   * (sharp on a request path is not free), and the derivative is keyed off the
   * original's `object_key` so it also covers photos uploaded before
   * thumbnails existed. A cached derivative is never invalidated because
   * `attachments` rows are immutable once confirmed — a replaced product photo
   * is a NEW attachment id, and therefore a new key.
   *
   * `sha256` of the DERIVATIVE is returned for the caller to use as an ETag, so
   * a still-warm device revalidates with a 304 instead of re-downloading.
   */
  async getThumbnailBytes(
    client: PoolClient,
    user: JwtAccessPayload,
    locationScope: string[] | null,
    id: string,
    maxPx: number,
  ): Promise<{ buffer: Buffer; mimeType: string; etag: string }> {
    const row = await this.findAttachment(client, id);
    this.assertEntityScope(user, locationScope, row);

    if (!isProcessableImage(row.mime_type)) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'Attachment is not an image',
      });
    }

    const thumbKey = `thumbs/${maxPx}/${row.object_key}`;

    try {
      const cached = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: thumbKey }),
      );
      const buffer = await collectStream(cached.Body as AsyncIterable<Buffer>);
      return { buffer, mimeType: 'image/webp', etag: sha256Hex(buffer) };
    } catch {
      // Not generated yet (or the derivative was evicted) — fall through and build it.
    }

    const original = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: row.object_key }),
    );
    const originalBuffer = await collectStream(original.Body as AsyncIterable<Buffer>);
    const thumb = await makeThumbnail(originalBuffer, maxPx);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: thumbKey,
          Body: thumb.buffer,
          ContentType: thumb.mimeType,
        }),
      );
    } catch (err) {
      // A failed cache WRITE must not fail the READ — the caller still gets
      // its bytes, the next request just pays for the resize again.
      this.logger.warn(
        `Could not cache thumbnail ${thumbKey}: ${err instanceof Error ? err.message : err}`,
      );
    }

    return { buffer: thumb.buffer, mimeType: thumb.mimeType, etag: thumb.sha256 };
  }

  private toDto(row: AttachmentRow, url: string): AttachmentDto {
    return {
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      kind: row.kind,
      entityType: row.entity_type,
      entityId: row.entity_id,
      url,
    };
  }
}
