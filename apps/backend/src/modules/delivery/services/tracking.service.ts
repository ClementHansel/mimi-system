import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LiveDelivery, SjPosition, UUID } from '@mimi/shared';
import { withWrite } from '../db-tx';
import type { RecordPositionsDto } from '../dto/tracking.dto';

interface PositionRow {
  latitude: string;
  longitude: string;
  accuracy_m: string | null;
  speed_kph: string | null;
  heading_deg: string | null;
  recorded_at: Date;
  received_at: Date;
}

/** pg hands back NUMERIC as a string to protect precision; every consumer of a
 * coordinate wants a number, so the conversion happens once, here. */
function mapPosition(r: PositionRow): SjPosition {
  return {
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
    speedKph: r.speed_kph === null ? null : Number(r.speed_kph),
    headingDeg: r.heading_deg === null ? null : Number(r.heading_deg),
    recordedAt: r.recorded_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
  };
}

/**
 * M10 `delivery` — live truck tracking (migration 221).
 *
 * Collection is deliberately narrow: the driver app reports only while its
 * Surat Jalan is `in_transit`, and this service enforces that server-side too
 * rather than trusting the client to stop. Positions are retained indefinitely
 * by owner decision (2026-08-18) — see migration 221's header before adding a
 * purge, and note this is employee location history.
 */
@Injectable()
export class TrackingService {
  /**
   * Ingest a BATCH of breadcrumbs. Batch rather than one-at-a-time because the
   * driver PWA is offline-first: on a Kalimantan route it will queue fixes
   * through a dead zone and flush thirty of them at once on reconnect.
   *
   * Idempotent on `client_id`. A phone that loses the response and re-sends
   * must not double-record the trail, so a replayed batch is a no-op rather
   * than an error — the driver has no way to resolve a 409 and would just
   * retry forever.
   */
  async recordPositions(
    client: PoolClient,
    sjId: UUID,
    dto: RecordPositionsDto,
    actorUserId: UUID,
  ) {
    return withWrite(client, async () => {
      const sj = await client.query<{ status: string; driver_id: string | null }>(
        `SELECT status, driver_id FROM surat_jalan WHERE id = $1`,
        [sjId],
      );
      const header = sj.rows[0];
      // RLS already prevents reading another trip's row, so a miss here is
      // genuinely "not found or not yours" — same shape the drop endpoints use.
      if (!header)
        throw new NotFoundException({
          code: 'ERR_NOT_FOUND',
          message: `Surat Jalan ${sjId} not found`,
        });

      // Refuse pings outside the trip window. Without this, a phone whose
      // background task leaked would keep writing location long after the
      // driver got home — collection that nobody asked for and that the
      // "only during an active trip" policy explicitly rules out.
      // `in_transit` is the only in-flight status in `surat_jalan`'s state
      // machine (033) — there is no 'dispatched' status, despite the
      // `dispatched_at` timestamp column and the `POST :id/dispatch` action
      // that sets it. Getting this wrong fails open in the worst direction:
      // a mismatched name would reject every real ping.
      if (header.status !== 'in_transit') {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Surat Jalan ${sjId} is ${header.status} — positions are only accepted while in transit`,
        });
      }

      let accepted = 0;
      for (const p of dto.positions) {
        const res = await client.query(
          `INSERT INTO sj_positions
             (sj_id, driver_id, latitude, longitude, accuracy_m, speed_kph, heading_deg, recorded_at, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (client_id) DO NOTHING`,
          [
            sjId,
            header.driver_id,
            p.latitude,
            p.longitude,
            p.accuracyM ?? null,
            p.speedKph ?? null,
            p.headingDeg ?? null,
            p.recordedAt,
            p.clientId,
          ],
        );
        accepted += res.rowCount ?? 0;
      }

      // `accepted` counts only rows that were genuinely new, so a client can
      // tell a successful flush from a duplicate replay without it being an error.
      return { sjId, submitted: dto.positions.length, accepted, actorUserId };
    });
  }

  /** The breadcrumb trail for one trip, oldest first — used to draw the path
   * the truck actually took. `since` lets the live view poll for just the tail
   * instead of re-fetching a whole day's trail every few seconds. */
  async getTrail(
    client: PoolClient,
    sjId: UUID,
    since?: string,
    limit = 500,
  ): Promise<SjPosition[]> {
    const params: unknown[] = [sjId];
    let where = `sj_id = $1`;
    if (since) {
      params.push(since);
      where += ` AND recorded_at > $${params.length}`;
    }
    params.push(limit);
    const res = await client.query<PositionRow>(
      `SELECT latitude, longitude, accuracy_m, speed_kph, heading_deg, recorded_at, received_at
         FROM sj_positions
        WHERE ${where}
        ORDER BY recorded_at ASC
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(mapPosition);
  }

  /**
   * Every truck currently on the road plus its most recent fix — the
   * dispatcher's live board.
   *
   * The lateral join takes the latest position per trip; it rides the
   * `(sj_id, recorded_at DESC)` index from migration 221, so this stays flat as
   * `sj_positions` grows without bound under the indefinite-retention policy.
   */
  async getLiveBoard(client: PoolClient): Promise<LiveDelivery[]> {
    const res = await client.query<
      PositionRow & {
        sj_id: string;
        sj_number: string;
        driver_id: string | null;
        driver_name: string | null;
        plate_number: string | null;
        status: string;
        dispatched_at: Date | null;
        total_drops: string;
        completed_drops: string;
        has_position: boolean;
      }
    >(
      `SELECT sj.id AS sj_id, sj.sj_number, sj.driver_id, dr.name AS driver_name,
              v.plate_number, sj.status, sj.dispatched_at,
              (SELECT COUNT(*) FROM sj_drops d WHERE d.sj_id = sj.id) AS total_drops,
              (SELECT COUNT(*) FROM sj_drops d WHERE d.sj_id = sj.id
                 AND d.status IN ('completed','completed_discrepancy')) AS completed_drops,
              (p.recorded_at IS NOT NULL) AS has_position,
              p.latitude, p.longitude, p.accuracy_m, p.speed_kph, p.heading_deg,
              p.recorded_at, p.received_at
         FROM surat_jalan sj
         LEFT JOIN drivers dr ON dr.id = sj.driver_id
         LEFT JOIN vehicles v ON v.id = sj.vehicle_id
         LEFT JOIN LATERAL (
           SELECT latitude, longitude, accuracy_m, speed_kph, heading_deg, recorded_at, received_at
             FROM sj_positions sp
            WHERE sp.sj_id = sj.id
            ORDER BY sp.recorded_at DESC
            LIMIT 1
         ) p ON TRUE
        WHERE sj.status = 'in_transit'
        ORDER BY sj.dispatched_at ASC NULLS LAST`,
    );

    return res.rows.map((r) => ({
      sjId: r.sj_id,
      sjNumber: r.sj_number,
      driverId: r.driver_id,
      driverName: r.driver_name,
      vehiclePlate: r.plate_number,
      status: r.status,
      dispatchedAt: r.dispatched_at ? r.dispatched_at.toISOString() : null,
      totalDrops: Number(r.total_drops),
      completedDrops: Number(r.completed_drops),
      // A truck in transit with no fix yet is normal in the first minute, and
      // permanent if the driver denied the browser's location permission — the
      // board renders that as "no signal", not as a truck at (0, 0).
      lastPosition: r.has_position ? mapPosition(r) : null,
    }));
  }
}
