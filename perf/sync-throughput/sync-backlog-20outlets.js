// "Sync throughput at 20 outlets x 1 day backlog" — the fourth bullet of
// W6-05's brief (docs/BUILD-PLAN.md Wave 6 table).
//
// WHAT THIS MEASURES: how long `POST /sync/v1/push`
// (apps/backend/src/kernel/sync/sync-http.controller.ts, backed by
// `SyncIngestService.ingestBatch`) takes to durably ingest a batch of
// device-originated facts, at the volume 20 outlets going from "fully
// offline for a day" to "fully synced" would produce simultaneously on
// reconnect (e.g. after a shared ISP outage — a real Kalimantan scenario per
// BUILD-PLAN's own framing, not a hypothetical).
//
// DELIBERATE SCOPE LIMIT, READ BEFORE TRUSTING THE NUMBER THIS PRODUCES:
// `SyncPushBatch` payloads are schema-validated per (entity, op) pair
// against `@mimi/sync-protocol/src/schema/registry.ts`
// (`sync-ingest.service.ts`'s `checkAuthority`, step "structural validation
// against W1-B's payload schema registry"). Synthesizing a VALID payload for
// every entity a real day would push (sales, sale_lines-as-embedded-data,
// stock_opname, attendance, ...) is a much larger effort than a perf ticket
// scope, and getting even one field wrong makes every event `malformed` —
// which would silently turn this into a rejection-speed benchmark instead of
// an ingest-throughput one.
//
// This script instead pushes `attendance.checked_in`/`checked_out` events
// (`SyncEntity.ATTENDANCE`, class F, device-originatable, minimal schema —
// see authority-matrix.ts:153 and registry.ts:666-681) AT THE SAME VOLUME
// PER OUTLET a real day's mixed backlog would carry, as a same-order-of-
// magnitude STAND-IN for "how many rows does the ingest pipeline have to
// apply per outlet per day," not as a claim that attendance IS the
// production traffic mix. If the owner can state a real per-outlet daily
// event count (sales + attendance + opname + ...), replace
// EVENTS_PER_OUTLET below with it — that is the one number in this file
// that is invented rather than sourced from a doc, flagged exactly as the
// ticket brief asked.
//
// No written NFR covers sync throughput specifically (NFR-01 is the request/
// response one, docs/ACCEPTANCE.md §7) — thresholds below are therefore
// "pass/fail is TBD by the owner"; only `http_req_failed` (the batch must not
// error) is enforced.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, OUTLET_CODES } from '../k6/lib/config.js';
import { login, authHeaders } from '../k6/lib/auth.js';
import { uuidv4 } from '../k6/lib/uuid.js';

const EVENTS_PER_OUTLET = Number(__ENV.EVENTS_PER_OUTLET || 40); // see header — invented, replace when a real count exists.
const MAX_BATCH_SIZE = 200; // SYNC-PROTOCOL §4.3 hard cap, mirrored in SyncPushBatch's own doc comment.
const OUTLET_COUNT = Number(__ENV.OUTLET_COUNT || 20);

export const options = {
  scenarios: {
    sync_backlog: {
      executor: 'per-vu-iterations',
      vus: OUTLET_COUNT,
      iterations: 1,
      maxDuration: '5m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // No p95 asserted deliberately — see file header. Read the summary's
    // `sync_push_duration` custom metric and report it; do not gate on it
    // until the owner supplies a target.
  },
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** One `attendance.checked_in`/`checked_out` pair, shaped per registry.ts:666-681. */
function attendanceEvents(deviceId, locationId, actorUserId, occurredAt) {
  const base = {
    originTier: 'device',
    originDeviceId: deviceId,
    locationId,
    entity: 'attendance',
    entityId: uuidv4(),
    actorUserId,
    schemaV: 1,
    occurredAt,
  };
  const metaFor = () => ({ actorUserId, actorRole: 'kasir', appVersion: 'perf-test-1.0' });
  const dataFor = () => ({
    clientId: uuidv4(),
    locationId,
    lat: '-1.2379000',
    lng: '116.8529000',
    accuracyM: 8,
    selfieAttachmentId: uuidv4(), // structural (uuid-shaped) only — no real attachment row; see header.
  });
  return [
    {
      ...base,
      op: 'checked_in',
      payload: { v: 1, data: dataFor(), meta: metaFor() },
    },
    {
      ...base,
      entityId: uuidv4(),
      op: 'checked_out',
      payload: { v: 1, data: dataFor(), meta: metaFor() },
    },
  ];
}

/** Setup: mint a pairing token + register a real device per outlet, exactly the flow a genuine tablet
 * goes through (CONTRACTS.md §4.21) — so the load this script generates exercises the real ingest path,
 * not a shortcut into `sync_events`. */
export function setup() {
  const { accessToken, roleKey: _roleKey } = login(BASE_URL, 'owner');
  const ownerHeaders = authHeaders(accessToken);

  const meRes = http.get(`${BASE_URL}/api/auth/me`, { headers: ownerHeaders });
  const actorUserId = JSON.parse(meRes.body).id;

  const locRes = http.get(`${BASE_URL}/api/location?type=outlet`, { headers: ownerHeaders });
  const allOutlets = JSON.parse(locRes.body).rows || JSON.parse(locRes.body);
  const byCode = {};
  for (const loc of allOutlets) byCode[loc.code] = loc;

  const devices = [];
  for (const code of OUTLET_CODES.slice(0, OUTLET_COUNT)) {
    const loc = byCode[code];
    if (!loc) continue; // seed not loaded, or fewer outlets than expected — skip rather than fail the whole run

    const mintRes = http.post(
      `${BASE_URL}/api/devices/pairing-tokens`,
      JSON.stringify({ locationId: loc.id }),
      { headers: ownerHeaders },
    );
    if (mintRes.status !== 200 && mintRes.status !== 201) continue;
    const { token } = JSON.parse(mintRes.body);

    const regRes = http.post(
      `${BASE_URL}/api/devices/register`,
      JSON.stringify({
        token,
        fingerprint: uuidv4(),
        category: 'pos_terminal',
        appVersion: 'perf-test-1.0',
      }),
      { headers: { 'Content-Type': 'application/json' } }, // @Public — no bearer token
    );
    if (regRes.status !== 200 && regRes.status !== 201) continue;
    const reg = JSON.parse(regRes.body);

    devices.push({
      code,
      locationId: loc.id,
      deviceId: reg.deviceId,
      deviceToken: reg.deviceToken,
    });
  }

  if (devices.length === 0) {
    throw new Error(
      'no devices could be registered — is the seed loaded, and does "owner" hold device.pair?',
    );
  }
  return { devices, actorUserId };
}

export default function (data) {
  const device = data.devices[(__VU - 1) % data.devices.length];
  if (!device) return;

  const occurredAt = new Date().toISOString();
  const allEvents = [];
  for (let i = 0; i < Math.ceil(EVENTS_PER_OUTLET / 2); i++) {
    allEvents.push(
      ...attendanceEvents(device.deviceId, device.locationId, data.actorUserId, occurredAt),
    );
  }
  // client_seq must be gapless/monotonic PER ORIGIN device (SYNC-PROTOCOL §2.1/§6.1) — a fresh
  // per-iteration base is fine here because each device was JUST registered in setup() (high-water 0).
  allEvents.forEach((e, i) => {
    e.clientSeq = String(i + 1);
  });

  const batches = chunk(allEvents, MAX_BATCH_SIZE);
  let totalAccepted = 0;
  const start = Date.now();

  for (const batch of batches) {
    const body = { batchId: uuidv4(), sentAt: new Date().toISOString(), events: batch };
    const res = http.post(`${BASE_URL}/sync/v1/push`, JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${device.deviceToken}`,
      },
      tags: { name: 'sync_push' },
    });
    const ok = check(res, { 'sync push: 200': (r) => r.status === 200 });
    if (ok) {
      try {
        const ack = JSON.parse(res.body);
        totalAccepted += batch.length - (ack.rejected ? ack.rejected.length : 0);
      } catch {
        /* leave totalAccepted as-is; the check above already flagged this */
      }
    }
  }

  const elapsedMs = Date.now() - start;
  console.log(
    `[sync-backlog] outlet=${device.code} events=${allEvents.length} batches=${batches.length} ` +
      `accepted=${totalAccepted} elapsedMs=${elapsedMs} eventsPerSec=${(
        (allEvents.length / elapsedMs) *
        1000
      ).toFixed(1)}`,
  );
}
