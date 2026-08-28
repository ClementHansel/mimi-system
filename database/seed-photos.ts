/**
 * Photo seed — real image BYTES in object storage, linked to real rows.
 *
 * ## Why this exists at all
 *
 * Every other seed pass writes database rows. This one is different: it is the
 * only pass that puts an OBJECT in MinIO. That matters because
 * `products.photo_attachment_id` and `employees.photo_attachment_id` were NULL
 * on every row, so the POS product grid, the menu editor and the employee
 * directory all rendered their empty-state placeholder on a fully-seeded
 * database.
 *
 * The tempting shortcut — insert `attachments` rows and link them, without
 * uploading anything — is worse than leaving the columns NULL. A linked
 * attachment whose object does not exist turns a clean placeholder into a
 * broken image: the screen requests a presigned URL, the URL resolves, and
 * MinIO returns 404. On a database whose entire job is to make real bugs
 * visible, that would manufacture a fake one on every product tile. So this
 * either uploads real bytes or links nothing.
 *
 * ## Why the PNGs are hand-rolled
 *
 * A placeholder image generator would mean an image library (sharp, canvas,
 * jimp) — a native-binary dependency, in a seed script, to draw a coloured
 * rectangle. This repo has a standing precedent for the opposite choice
 * (`xlsx-writer.util.ts` hand-rolls a `.xlsx`, `lib/export/pdf.ts` hand-rolls a
 * PDF), and a PNG is genuinely simple when you do not need compression
 * cleverness: `node:zlib` supplies the DEFLATE that the format requires, and
 * the rest is three chunks with CRC32s.
 *
 * Each image is a flat colour derived from a hash of the row's own name, so
 * tiles are visually DISTINGUISHABLE from one another (the point — a grid of
 * 39 identical grey squares teaches you nothing about whether the right photo
 * is on the right product) and STABLE across reseeds (the same product is
 * always the same colour, so a screenshot from last week still matches).
 *
 * These are obviously synthetic placeholders, not photographs of food. That is
 * deliberate: nobody should mistake dev data for real product photography.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';

// ── Minimal PNG encoder ──────────────────────────────────────────────────────

/** PNG's CRC-32 (ISO 3309), table-driven — the same polynomial ZIP uses. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over (type + data). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A `size`×`size` PNG: a flat background with a lighter diagonal band, so the
 * image is recognisably an image (and its orientation is visible) rather than
 * a colour swatch that could equally be a CSS background.
 */
export function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const [r, g, b] = rgb;
  const light: [number, number, number] = [
    Math.min(255, r + 40),
    Math.min(255, g + 40),
    Math.min(255, b + 40),
  ];

  // Raw scanlines: each row is a filter byte (0 = None) then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const onBand = (x + y) % size < size / 3;
      const [cr, cg, cb] = onBand ? light : [r, g, b];
      raw[p++] = cr;
      raw[p++] = cg;
      raw[p++] = cb;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A stable, reasonably saturated colour for a name — same name, same colour, every reseed. */
export function colorFor(name: string): [number, number, number] {
  const digest = createHash('sha256').update(name).digest();
  // Keep each channel in 60..215 so text/borders stay legible over it and no
  // tile is pure black or a blown-out white.
  return [60 + (digest[0]! % 156), 60 + (digest[1]! % 156), 60 + (digest[2]! % 156)];
}

// ── Upload + link ────────────────────────────────────────────────────────────

interface PhotoTarget {
  table: 'products' | 'employees';
  entityType: string;
  kind: string;
  size: number;
}

const TARGETS: PhotoTarget[] = [
  { table: 'products', entityType: 'product', kind: 'product_photo', size: 96 },
  { table: 'employees', entityType: 'employee', kind: 'employee_photo', size: 64 },
];

function s3(): { client: S3Client; bucket: string } | null {
  const endpoint = process.env.MINIO_ENDPOINT
    ? `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? '9000'}`
    : (process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  const accessKeyId = process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER;
  const secretAccessKey = process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD;
  const bucket = process.env.MINIO_BUCKET ?? 'mimi-storage';
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    client: new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

/**
 * Attaches the orphaned evidence photos to the documents they are evidence
 * FOR.
 *
 * `seed-extended.ts` creates `attachments` rows for the "wajib foto"
 * requirements (a receiving photo, a payment proof, a waste photo, a cold-chain
 * probe reading) but leaves `entity_type`/`entity_id` NULL on most of them. The
 * row exists, so the attachment count looks healthy; the DOCUMENT it belongs to
 * shows no evidence at all. That is precisely the "data is not linked properly"
 * shape this dev database exists to expose — and worse than an empty table,
 * because nothing about it looks wrong until you open the document and find a
 * mandatory photo missing.
 *
 * Each orphan is matched to a document of the corresponding type that does not
 * already have one, oldest first, so the link is arbitrary but never
 * DOUBLE-assigns and never invents a document. Anything with no matching
 * document is left alone rather than pointed somewhere plausible-but-wrong.
 */
async function linkOrphanEvidence(client: pg.Client): Promise<void> {
  const pairs: { kind: string; entityType: string; table: string }[] = [
    { kind: 'receiving_photo', entityType: 'goods_receipt', table: 'goods_receipts' },
    { kind: 'payment_proof', entityType: 'payment_verification', table: 'payment_verifications' },
    { kind: 'waste_photo', entityType: 'waste_record', table: 'waste_records' },
  ];

  let linked = 0;
  for (const pair of pairs) {
    const orphans = (
      await client.query<{ id: string }>(
        `SELECT id FROM attachments WHERE kind = $1 AND entity_id IS NULL ORDER BY created_at`,
        [pair.kind],
      )
    ).rows;
    if (orphans.length === 0) continue;

    const documents = (
      await client.query<{ id: string }>(
        `SELECT d.id FROM ${pair.table} d
          WHERE NOT EXISTS (
                SELECT 1 FROM attachments a
                 WHERE a.entity_type = $1 AND a.entity_id = d.id AND a.kind = $2
              )
          ORDER BY d.created_at
          LIMIT $3`,
        [pair.entityType, pair.kind, orphans.length],
      )
    ).rows;

    for (let i = 0; i < Math.min(orphans.length, documents.length); i++) {
      await client.query(`UPDATE attachments SET entity_type = $2, entity_id = $3 WHERE id = $1`, [
        orphans[i]!.id,
        pair.entityType,
        documents[i]!.id,
      ]);
      linked++;
    }
  }
  // `probe` readings belong to a temperature log, not to a document with a
  // photo slot, and `sj_temperature_logs` has no attachment column to point
  // back at — so those are left unlinked deliberately rather than attached to
  // something they are not evidence for.
  console.log(`  - evidence: ${linked} orphaned photos attached to their documents`);
}

/**
 * Gives every product and employee a photo. Skips rows that already have one,
 * so it is idempotent like the other passes.
 *
 * If object storage is not reachable or has no credentials, this logs and
 * returns WITHOUT linking anything — see the header: a link with no object
 * behind it is worse than no link.
 */
export async function seedPhotos(client: pg.Client): Promise<void> {
  console.log('\n→ Photo seed (real objects in MinIO, linked to products + employees)...\n');

  const storage = s3();
  if (!storage) {
    console.log(
      '  ! no MinIO credentials in env — skipping (photos stay NULL, which renders a clean placeholder)',
    );
    return;
  }

  const uploader = (
    await client.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`)
  ).rows[0]?.id;

  for (const target of TARGETS) {
    const rows = (
      await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM ${target.table} WHERE photo_attachment_id IS NULL ORDER BY name`,
      )
    ).rows;

    let made = 0;
    for (const row of rows) {
      const png = solidPng(target.size, colorFor(`${target.table}:${row.name}`));
      const objectKey = `seed/${target.entityType}/${row.id}.png`;
      try {
        await storage.client.send(
          new PutObjectCommand({
            Bucket: storage.bucket,
            Key: objectKey,
            Body: png,
            ContentType: 'image/png',
          }),
        );
      } catch (err) {
        console.log(
          `  ! upload failed (${(err as Error).message}) — leaving ${target.table} photos NULL`,
        );
        return;
      }

      const attachment = await client.query<{ id: string }>(
        `INSERT INTO attachments
           (bucket, object_key, file_name, mime_type, size_bytes, sha256, entity_type, entity_id, kind, uploaded_by)
         VALUES ($1,$2,$3,'image/png',$4,$5,$6,$7,$8,$9)
         ON CONFLICT (object_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
         RETURNING id`,
        [
          storage.bucket,
          objectKey,
          `${row.name}.png`,
          png.length,
          createHash('sha256').update(png).digest('hex'),
          target.entityType,
          row.id,
          target.kind,
          uploader,
        ],
      );
      await client.query(`UPDATE ${target.table} SET photo_attachment_id = $2 WHERE id = $1`, [
        row.id,
        attachment.rows[0]!.id,
      ]);
      made++;
    }
    console.log(`  - ${target.table}: ${made} photos uploaded and linked`);
  }

  await linkOrphanEvidence(client);

  console.log('\n✓ Photo seed completed.\n');
}
