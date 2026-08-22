/**
 * "Can a phone actually upload a photo?" — run INSIDE the backend container, so
 * it uses exactly the credentials and endpoints the running app uses.
 *
 * This exists because that question was answered "yes" by every check we had
 * and the truth was "no, and it never could have been". `presign` returned 200,
 * the deploy went green, and the URL it handed out pointed at `http://minio:9000`
 * — a host no device can resolve. Attendance selfies and waste photos are
 * MANDATORY fields, so the whole feature was dead behind a healthy-looking API.
 *
 * It signs and PUTs twice, which is the point: one upload against the internal
 * endpoint and one against the public one. Comparing the two localises a failure
 * to either the credentials (both fail) or the proxy (only the public one
 * fails), which is exactly the distinction that is impossible to make from the
 * app's own error messages.
 *
 * Deliberately writes and then deletes one small object under `probe/`.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

// The proxy in front of MinIO uses a self-signed certificate by design (B-14),
// so this probe must not judge it — it is testing reachability and signatures,
// not trust.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const bucket = process.env.MINIO_BUCKET ?? 'mimi-storage';
const host = process.env.MINIO_ENDPOINT ?? 'localhost';
const port = process.env.MINIO_PORT ?? '9000';
const ssl = String(process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true';
const internal = process.env.S3_ENDPOINT ?? `${ssl ? 'https' : 'http'}://${host}:${port}`;
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? '';

const credentials = {
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? '',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? '',
};

if (!credentials.accessKeyId) {
  console.log('FAIL no object-storage credentials in this container');
  process.exit(1);
}

const body = new Uint8Array(Buffer.from('mimi-storage-probe'));

async function attempt(label, endpoint) {
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials,
  });
  const key = `probe/${randomUUID()}.bin`;
  let url;
  try {
    url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: 300,
    });
  } catch (err) {
    console.log(`${label}: could not sign — ${err instanceof Error ? err.message : err}`);
    return;
  }
  let res;
  try {
    res = await fetch(url, { method: 'PUT', body });
  } catch (err) {
    console.log(`${label}: unreachable — ${err instanceof Error ? err.message : err}`);
    return;
  }
  const text = res.ok ? '' : await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
  console.log(`${label}: PUT ${res.status} ${code}`.trimEnd());

  if (res.ok) {
    // Cleaned up through the INTERNAL client, which is known to work by the
    // time this runs, so a proxy fault cannot leave litter behind.
    const cleaner = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: internal,
      forcePathStyle: true,
      credentials,
    });
    await cleaner
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      .catch(() => console.log(`${label}: (probe object ${key} left behind)`));
  }
}

console.log(`internal endpoint : ${internal}`);
console.log(`public endpoint   : ${publicEndpoint || '(unset — devices cannot upload)'}`);
console.log(`access key        : ${credentials.accessKeyId}`);

await attempt('internal', internal);
if (publicEndpoint) await attempt('public  ', publicEndpoint);
