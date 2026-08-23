/**
 * DAY SIMULATION — drives one real trading day through the HTTP API as the
 * actual people `simulate-org.ts` created.
 *
 * `simulate-org.ts` builds the owner's org (crew per shift, managers over
 * regions, 2 gudang staff + 2 drivers). That only proves the DATA is shaped
 * right. This script proves the SYSTEM works for those people: every step below
 * is a real request, with a real login, against a running backend — no service
 * constructed by hand, no RLS bypass, no fixture.
 *
 * It is deliberately not a test suite. A test asserts a known-good expectation
 * and fails the build; this reports what the business can and cannot do today,
 * including where the app is more permissive than the org chart. Three kinds of
 * outcome:
 *
 *   OK        the step worked, and it should have
 *   BLOCKED   the step was refused, and being refused is CORRECT (a boundary
 *             holding: a cook cannot open a till)
 *   FINDING   the result disagrees with how the owner described the business —
 *             either something that should work and does not, or something that
 *             should be refused and was allowed
 *
 * Usage:
 *   npx tsx database/simulate-day.ts        # backend on :4000, DB from DATABASE_MIGRATION_URL
 *
 * `API` overrides the backend URL, but the database and the API must be the SAME
 * environment: the fixtures below (location ids, a product, an item with stock)
 * are read straight from the database, and pointing the API at another box would
 * send it ids that do not exist there. Driving the VPS therefore needs a
 * connection to the VPS database, which is bound to 127.0.0.1 by design.
 *
 * It writes real sales, attendance and stock movements, so the target should
 * always be a deliberate choice rather than a default.
 */

import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';

const { Client } = pg;

const API = process.env.API ?? 'http://127.0.0.1:4000/api';
const PASSWORD = 'password123';
/** The branch the day is simulated at, and one in the OTHER manager's region. */
const HOME = 'BPP01';
const AWAY = 'PTK01';

type Outcome = 'OK' | 'BLOCKED' | 'FINDING';
interface Step {
  actor: string;
  what: string;
  outcome: Outcome;
  detail: string;
}
const steps: Step[] = [];

function record(actor: string, what: string, outcome: Outcome, detail: string): void {
  steps.push({ actor, what, outcome, detail });
  const tag = outcome === 'OK' ? 'OK     ' : outcome === 'BLOCKED' ? 'BLOCKED' : 'FINDING';
  console.log(`  ${tag}  ${actor.padEnd(16)} ${what}${detail ? ` — ${detail}` : ''}`);
}

interface Session {
  username: string;
  token: string;
  roleKey: string;
  userId: string;
}

async function login(username: string): Promise<Session> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${username}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accessToken: string };
  // The role and user id come from the token itself rather than a second
  // request: it is the same claim set the guards read, so a mismatch between
  // "who I think I am" and "who the server thinks I am" cannot hide here.
  const claims = JSON.parse(Buffer.from(body.accessToken.split('.')[1]!, 'base64').toString()) as {
    sub: string;
    roleKey: string;
  };
  return { username, token: body.accessToken, roleKey: claims.roleKey, userId: claims.sub };
}

interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T;
  errorCode?: string;
  message?: string;
}

async function call<T = unknown>(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the text — an HTML error page is itself the useful signal */
  }
  const envelope = parsed as { code?: string; message?: string };
  return {
    status: res.status,
    ok: res.ok,
    body: parsed as T,
    errorCode: envelope?.code,
    message: typeof envelope?.message === 'string' ? envelope.message : undefined,
  };
}

/** Shortens an API failure to something readable in a one-line report. */
function why(result: ApiResult<unknown>): string {
  return `HTTP ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}${
    result.message ? `: ${result.message.slice(0, 90)}` : ''
  }`;
}

/**
 * Uploads a photo for real: presign -> PUT the bytes at the returned URL ->
 * confirm with the sha256.
 *
 * Faked attachment ids were not an option. A selfie is MANDATORY on attendance
 * (FR-HR-01) and a photo is mandatory on waste (FR-WST-01), so a simulation
 * that skipped the upload would skip the two rules most likely to make those
 * screens unusable on a phone — and would never have caught the presign URL
 * being unreachable from outside the container network.
 */
async function uploadPhoto(
  session: Session,
  kind: string,
  locationId: string,
): Promise<string | null> {
  // A REAL 8x8 baseline JPEG straight out of an encoder, not a hand-assembled
  // header. The first attempt used a truncated blob and `confirm` answered 500
  // with "Corrupt JPEG data: 18 extraneous bytes" — sharp was right and the
  // fixture was wrong. Worth recording: the server re-encodes and strips EXIF
  // on upload, so anything that is not a decodable image fails at CONFIRM, not
  // at presign, which is a confusing place to find out your fixture is bad.
  const bytes = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCzRRRXwR9sf//Z',
    'base64',
  );
  const presign = await call<{ attachmentId: string; uploadUrl: string }>(
    session,
    'POST',
    '/attachments/presign',
    {
      fileName: `${kind}-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.length,
      kind,
      locationId,
    },
  );
  if (!presign.ok) {
    record(session.username, `upload ${kind} photo`, 'FINDING', `presign failed — ${why(presign)}`);
    return null;
  }
  const put = await fetch(presign.body.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) {
    record(
      session.username,
      `upload ${kind} photo`,
      'FINDING',
      `PUT to the presigned URL failed — HTTP ${put.status}. The URL the API hands a phone must be reachable from outside the container network.`,
    );
    return null;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const confirm = await call(session, 'POST', `/attachments/${presign.body.attachmentId}/confirm`, {
    sha256,
  });
  if (!confirm.ok) {
    record(session.username, `upload ${kind} photo`, 'FINDING', `confirm failed — ${why(confirm)}`);
    return null;
  }
  return presign.body.attachmentId;
}

/** Facts the simulation needs that are not worth an API round trip to discover. */
interface Fixtures {
  locationId: Record<string, string>;
  coords: Record<string, { lat: string; lng: string }>;
  productIds: string[];
  productPrice: Record<string, string>;
  frozenItemId: string;
  frozenUnitId: string;
  storageAreaId: string;
  gudangId: string;
}

async function loadFixtures(): Promise<Fixtures> {
  const client = new Client({
    connectionString:
      process.env.DATABASE_MIGRATION_URL || 'postgresql://mimi:mimi_secret@localhost:5432/mimi',
  });
  await client.connect();
  try {
    const locs = (
      await client.query<{ code: string; id: string; latitude: string; longitude: string }>(
        `SELECT code, id, latitude, longitude FROM locations`,
      )
    ).rows;
    const locationId: Record<string, string> = {};
    const coords: Record<string, { lat: string; lng: string }> = {};
    for (const l of locs) {
      locationId[l.code] = l.id;
      coords[l.code] = { lat: String(l.latitude), lng: String(l.longitude) };
    }
    const products = (
      await client.query<{ id: string; price: string }>(
        `SELECT id, price FROM products WHERE is_active ORDER BY code LIMIT 3`,
      )
    ).rows;
    const item = (
      await client.query<{ item_id: string; unit_id: string; storage_area_id: string }>(
        `SELECT sb.item_id, i.base_unit_id AS unit_id, sb.storage_area_id
           FROM stock_balances sb
           JOIN items i ON i.id = sb.item_id
           JOIN storage_areas sa ON sa.id = sb.storage_area_id
          WHERE sb.location_id = $1 AND sb.qty_on_hand > 5
          ORDER BY sb.qty_on_hand DESC
          LIMIT 1`,
        [locationId[HOME]],
      )
    ).rows[0];
    if (!item) throw new Error(`No stock at ${HOME} — run \`pnpm db:seed\` first.`);
    return {
      locationId,
      coords,
      productIds: products.map((p) => p.id),
      productPrice: Object.fromEntries(products.map((p) => [p.id, p.price])),
      frozenItemId: item.item_id,
      frozenUnitId: item.unit_id,
      storageAreaId: item.storage_area_id,
      gudangId: locationId.GDG!,
    };
  } finally {
    await client.end();
  }
}

/** Moves a lat/lng by roughly `metres` north — for the outside-the-fence case. */
function offsetLat(lat: string, metres: number): string {
  return (Number(lat) + metres / 111_320).toFixed(6);
}

async function main(): Promise<void> {
  console.log(`\nDay simulation against ${API}\n`);
  const fx = await loadFixtures();

  // ── the morning crew at BPP01 ───────────────────────────────────────────────
  const shift = 'p';
  const spv = await login(`spv_${HOME.toLowerCase()}_${shift}`);
  const kasir = await login(`kasir_${HOME.toLowerCase()}_${shift}`);
  const cook = await login(`koki1_${HOME.toLowerCase()}_${shift}`);
  const manager = await login('manager1');
  const otherManager = await login('manager2');
  const gudang = await login('gudang1');
  const driver = await login('driver1');
  console.log(
    `  crew: ${spv.username} (${spv.roleKey}), ${kasir.username} (${kasir.roleKey}), ` +
      `${cook.username} (${cook.roleKey})\n`,
  );

  const home = fx.locationId[HOME]!;
  const away = fx.locationId[AWAY]!;

  console.log('1. The crew clocks in (200 m geofence, selfie mandatory)\n');

  for (const person of [spv, kasir, cook]) {
    const selfie = await uploadPhoto(person, 'attendance_selfie', home);
    if (!selfie) continue;
    const at = fx.coords[HOME]!;
    const res = await call(person, 'POST', '/hr/attendance/check-in', {
      clientId: randomUUID(),
      locationId: home,
      lat: at.lat,
      lng: at.lng,
      accuracyM: 12,
      selfieAttachmentId: selfie,
    });
    if (res.ok) record(person.username, 'check in at the outlet', 'OK', '');
    else if (res.errorCode === 'ERR_DUPLICATE' || res.status === 409)
      record(person.username, 'check in at the outlet', 'OK', 'already checked in today');
    else record(person.username, 'check in at the outlet', 'FINDING', why(res));
  }

  // The rule the owner asked for, tested from the wrong side: 5 km away must fail.
  //
  // It uses the SECOND cook, who has not checked in yet, and it reads the reason
  // for the refusal rather than just its status. The first version of this step
  // reused the same cook and was "BLOCKED" by
  // `ERR_CONFLICT: already checked in today` — a pass for the wrong reason,
  // which would have reported a working geofence without ever testing one.
  const farCook = await login(`koki2_${HOME.toLowerCase()}_${shift}`);
  const farSelfie = await uploadPhoto(farCook, 'attendance_selfie', home);
  if (farSelfie) {
    const at = fx.coords[HOME]!;
    const res = await call(farCook, 'POST', '/hr/attendance/check-in', {
      clientId: randomUUID(),
      locationId: home,
      lat: offsetLat(at.lat, 5000),
      lng: at.lng,
      accuracyM: 12,
      selfieAttachmentId: farSelfie,
    });
    const blob = JSON.stringify(res.body ?? {}).toLowerCase();
    const aboutDistance =
      blob.includes('geofence') ||
      blob.includes('radius') ||
      blob.includes('jarak') ||
      blob.includes('lokasi') ||
      blob.includes('distance');
    if (!res.ok && aboutDistance) {
      record(farCook.username, 'check in from 5 km away', 'BLOCKED', why(res));
    } else if (!res.ok) {
      record(
        farCook.username,
        'check in from 5 km away',
        'FINDING',
        `refused, but not for being out of range — ${why(res)}. The geofence is still unproven.`,
      );
    } else {
      record(
        farCook.username,
        'check in from 5 km away',
        'FINDING',
        'ACCEPTED — the 200 m geofence did not stop a check-in 5 km from the outlet',
      );
    }
  }

  console.log('\n2. The till: open, sell, close\n');

  const openRes = await call<{ id: string }>(kasir, 'POST', '/pos/shifts/open', {
    clientId: randomUUID(),
    locationId: home,
    openingCash: '200000.00',
  });
  let shiftId: string | null = null;
  if (openRes.ok) {
    shiftId = openRes.body.id;
    record(kasir.username, 'open the till', 'OK', `shift ${shiftId?.slice(0, 8)}`);
  } else if (openRes.errorCode === 'ERR_SHIFT_ALREADY_OPEN' || openRes.status === 409) {
    const current = await call<{ id: string }>(
      kasir,
      'GET',
      `/pos/shifts/current?locationId=${home}`,
    );
    shiftId = current.ok ? current.body.id : null;
    record(kasir.username, 'open the till', 'OK', 'a shift was already open — reusing it');
  } else {
    record(kasir.username, 'open the till', 'FINDING', why(openRes));
  }

  if (shiftId && fx.productIds.length > 0) {
    const productId = fx.productIds[0]!;
    const unitPrice = fx.productPrice[productId]!;
    const qty = '2.000';
    const total = (Number(unitPrice) * 2).toFixed(2);
    const sale = await call(kasir, 'POST', '/pos/sales', {
      clientId: randomUUID(),
      shiftId,
      locationId: home,
      occurredAt: new Date().toISOString(),
      lines: [{ productId, qty, unitPrice }],
      payments: [{ method: 'cash', amount: total }],
    });
    if (sale.ok) record(kasir.username, 'ring up a sale', 'OK', `Rp ${total}`);
    else record(kasir.username, 'ring up a sale', 'FINDING', why(sale));

    const close = await call(kasir, 'POST', `/pos/shifts/${shiftId}/close`, {
      closingCashCounted: (200_000 + Number(total)).toFixed(2),
      notes: 'Simulasi hari kerja',
    });
    if (close.ok) record(kasir.username, 'close the till', 'OK', 'counted cash matches');
    else record(kasir.username, 'close the till', 'FINDING', why(close));
  }

  console.log('\n3. Boundaries — the things each role must NOT be able to do\n');

  const cookTill = await call(cook, 'POST', '/pos/shifts/open', {
    clientId: randomUUID(),
    locationId: home,
    openingCash: '100000.00',
  });
  if (!cookTill.ok)
    record(cook.username, 'open a till (must be refused)', 'BLOCKED', why(cookTill));
  else
    record(
      cook.username,
      'open a till (must be refused)',
      'FINDING',
      'ALLOWED — a cook opened a cash drawer',
    );

  // The reason the `koki` role exists. As `leader_outlet` — which is what cooks
  // were before 2026-08-23 — every one of these would have SUCCEEDED.
  for (const [what, method, path, body] of [
    ['raise a stock request', 'POST', '/replenishment', { locationId: home, lines: [] }],
    ['record petty cash', 'POST', '/purchasing/petty-cash', { locationId: home }],
    ['start a stock count', 'POST', '/stock-opname', { locationId: home }],
  ] as const) {
    const res = await call(cook, method, path, body);
    // 403 is the interesting answer. A 400 would mean the body was rejected
    // before the permission was ever consulted, which proves nothing.
    if (res.status === 403) record(cook.username, `${what} (must be refused)`, 'BLOCKED', why(res));
    else if (res.ok) record(cook.username, `${what} (must be refused)`, 'FINDING', 'ALLOWED');
    else
      record(
        cook.username,
        `${what} (must be refused)`,
        'BLOCKED',
        `${why(res)} — refused, though not by the permission check`,
      );
  }

  const kasirAway = await call<{ rows?: unknown[] }>(kasir, 'GET', `/pos/sales?locationId=${away}`);
  if (!kasirAway.ok) {
    record(kasir.username, `read ${AWAY}'s sales (must be refused)`, 'BLOCKED', why(kasirAway));
  } else {
    const n = Array.isArray(kasirAway.body?.rows) ? kasirAway.body.rows.length : 0;
    if (n === 0)
      record(
        kasir.username,
        `read ${AWAY}'s sales (must be refused)`,
        'BLOCKED',
        'HTTP 200 but zero rows — RLS scoped the query away',
      );
    else
      record(
        kasir.username,
        `read ${AWAY}'s sales (must be refused)`,
        'FINDING',
        `${n} rows from another branch`,
      );
  }

  // The heart of "a manager who runs several branches".
  const awayForManager2 = await call<{ rows?: unknown[] }>(
    otherManager,
    'GET',
    `/pos/sales?locationId=${home}`,
  );
  if (!awayForManager2.ok) {
    record(
      otherManager.username,
      `read ${HOME} — outside their region`,
      'BLOCKED',
      why(awayForManager2),
    );
  } else {
    const n = Array.isArray(awayForManager2.body?.rows) ? awayForManager2.body.rows.length : 0;
    record(
      otherManager.username,
      `read ${HOME} — outside their region`,
      n > 0 ? 'FINDING' : 'BLOCKED',
      n > 0
        ? `${n} rows. manager2 runs Banjarmasin + Pontianak, yet reads Balikpapan: 'manager' is a company-wide role in RLS, so user_locations does not restrict it.`
        : 'zero rows',
    );
  }

  // The other half of scoping, and the one that would catch it being applied too
  // hard: a manager must still see their OWN region. "Nobody can see anything"
  // also produces zero findings above, so this is what stops a silent
  // over-correction reading as success.
  const homeForManager1 = await call<{ rows?: unknown[] }>(
    manager,
    'GET',
    `/pos/sales?locationId=${home}`,
  );
  const n1 = Array.isArray(homeForManager1.body?.rows) ? homeForManager1.body.rows.length : 0;
  if (homeForManager1.ok && n1 > 0)
    record(manager.username, `read ${HOME} — inside their region`, 'OK', `${n1} rows`);
  else
    record(
      manager.username,
      `read ${HOME} — inside their region`,
      'FINDING',
      homeForManager1.ok
        ? 'zero rows — the scope is too tight, a manager cannot see their own branches'
        : why(homeForManager1),
    );

  console.log('\n4. The outlet asks Gudang for stock, and the chain runs\n');

  const req = await call<{ id: string }>(spv, 'POST', '/replenishment', {
    locationId: home,
    source: 'manual',
    lines: [{ itemId: fx.frozenItemId, qtyRequested: '10.000', unitId: fx.frozenUnitId }],
  });
  let reqId: string | null = null;
  if (req.ok) {
    reqId = req.body.id;
    record(spv.username, 'raise a stock request', 'OK', `${reqId?.slice(0, 8)}`);
  } else {
    record(spv.username, 'raise a stock request', 'FINDING', why(req));
  }

  if (reqId) {
    const submit = await call(spv, 'POST', `/replenishment/${reqId}/submit`, {});
    if (submit.ok) record(spv.username, 'submit it for approval', 'OK', '');
    else record(spv.username, 'submit it for approval', 'FINDING', why(submit));

    const approve = await call(manager, 'POST', `/replenishment/${reqId}/approve`, {
      note: 'Disetujui — simulasi',
    });
    if (approve.ok) record(manager.username, 'approve it (their region)', 'OK', '');
    else record(manager.username, 'approve it (their region)', 'FINDING', why(approve));

    const queue = await call<{ rows?: Array<{ id: string }> }>(
      gudang,
      'GET',
      '/replenishment/queue/warehouse',
    );
    if (!queue.ok) {
      record(gudang.username, 'see the warehouse queue', 'FINDING', why(queue));
    } else {
      const rows = Array.isArray(queue.body?.rows) ? queue.body.rows : [];
      const mine = rows.some((r) => r.id === reqId);
      record(
        gudang.username,
        'see the warehouse queue',
        mine || rows.length > 0 ? 'OK' : 'FINDING',
        mine
          ? 'the approved request is in it'
          : rows.length > 0
            ? `${rows.length} requests queued, this one not yet visible`
            : 'queue is empty — an approved request should be waiting here',
      );
    }
  }

  console.log('\n5. Gudang and the driver\n');

  const sj = await call<{ rows?: unknown[] }>(gudang, 'GET', '/delivery/surat-jalan');
  if (sj.ok) {
    const n = Array.isArray(sj.body?.rows) ? sj.body.rows.length : 0;
    record(gudang.username, 'list Surat Jalan', 'OK', `${n} on file`);
  } else {
    record(gudang.username, 'list Surat Jalan', 'FINDING', why(sj));
  }

  const jobs = await call<unknown[]>(
    driver,
    'GET',
    `/delivery/my-jobs?date=${new Date().toISOString().slice(0, 10)}`,
  );
  if (jobs.ok) {
    const n = Array.isArray(jobs.body) ? jobs.body.length : 0;
    record(
      driver.username,
      "see today's delivery jobs",
      'OK',
      n > 0 ? `${n} job(s)` : 'none today (nothing dispatched yet)',
    );
  } else {
    record(driver.username, "see today's delivery jobs", 'FINDING', why(jobs));
  }

  console.log('\n6. The cook records spoilage, and reads their own record\n');

  const wastePhoto = await uploadPhoto(cook, 'waste_photo', home);
  if (wastePhoto) {
    const waste = await call(cook, 'POST', '/waste', {
      locationId: home,
      items: [
        {
          storageAreaId: fx.storageAreaId,
          itemId: fx.frozenItemId,
          qty: '0.500',
          // `WasteReason`, not free text — 'spoiled' is not one of them, and the
          // API's ERR_VALIDATION was right to say so.
          reason: 'expired',
        },
      ],
      photoAttachmentIds: [wastePhoto],
    });
    if (waste.ok) record(cook.username, 'record spoiled stock', 'OK', '0.5 unit');
    else record(cook.username, 'record spoiled stock', 'FINDING', why(waste));
  }

  const me = await call(cook, 'GET', '/hr/employees/me');
  if (me.ok) record(cook.username, 'open their own personal record', 'OK', '');
  else record(cook.username, 'open their own personal record', 'FINDING', why(me));

  // The roster endpoint is location+range scoped rather than `/me`, so a cook
  // reads their own crew by asking for their outlet and filtering to themself.
  const today = new Date().toISOString().slice(0, 10);
  const myShifts = await call<unknown[]>(
    cook,
    'GET',
    `/hr/roster?locationId=${home}&from=${today}&to=${today}`,
  );
  if (myShifts.ok) {
    const n = Array.isArray(myShifts.body) ? myShifts.body.length : 0;
    record(cook.username, 'see their own roster', n > 0 ? 'OK' : 'FINDING', `${n} assignment(s)`);
  } else {
    record(cook.username, 'see their own roster', 'FINDING', why(myShifts));
  }

  // ── the tally ──────────────────────────────────────────────────────────────
  const counts = steps.reduce<Record<Outcome, number>>(
    (acc, s) => ({ ...acc, [s.outcome]: acc[s.outcome] + 1 }),
    { OK: 0, BLOCKED: 0, FINDING: 0 },
  );
  console.log(
    `\n${'─'.repeat(78)}\n` +
      `${counts.OK} worked · ${counts.BLOCKED} correctly refused · ${counts.FINDING} finding(s)\n`,
  );
  if (counts.FINDING > 0) {
    console.log('Findings\n');
    for (const s of steps.filter((s) => s.outcome === 'FINDING')) {
      console.log(`  ${s.actor} — ${s.what}\n      ${s.detail}\n`);
    }
  }
}

main().catch((err: unknown) => {
  console.error('\nDay simulation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
