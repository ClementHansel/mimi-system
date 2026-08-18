import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_VALIDATION, type UUID } from '@mimi/shared';
import { withWrite } from '../db-tx';
import { selectSuratJalanHeaderForUpdate } from '../queries';
import type { PlanRouteDto } from '../dto/route.dto';

/**
 * M10 `delivery` — the gudang side of route planning.
 *
 * D-14 gave `sj_drops` an ordered `drop_seq` but no way to CHANGE it after the
 * Surat Jalan was built, and nowhere to record why a stop needs special
 * handling. A dispatcher who realised the route ran the wrong way round had to
 * cancel the SJ and rebuild it. This service closes that: reorder the stops,
 * and attach a per-stop delivery brief the driver reads on arrival.
 */
@Injectable()
export class RouteService {
  /**
   * Rewrite the stop order and per-stop instructions for one Surat Jalan.
   *
   * Editable only while `draft`/`ready`, matching `SuratJalanService.update`'s
   * window: once the truck is loaded and dispatched the driver may already be
   * en route to stop 1, and reshuffling the sequence under them would make the
   * app disagree with the physical load order of the vehicle.
   */
  async planRoute(client: PoolClient, sjId: UUID, dto: PlanRouteDto, _actorUserId: UUID) {
    return withWrite(client, async () => {
      const header = await selectSuratJalanHeaderForUpdate(client, sjId);
      if (!header)
        throw new NotFoundException({
          code: 'ERR_NOT_FOUND',
          message: `Surat Jalan ${sjId} not found`,
        });
      if (header.status !== 'draft' && header.status !== 'ready') {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Route can only be planned while the Surat Jalan is draft/ready (current: ${header.status})`,
        });
      }

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM sj_drops WHERE sj_id = $1`,
        [sjId],
      );
      const existingIds = new Set(existing.rows.map((r) => r.id));

      // The payload must be a permutation of THIS SJ's drops — every drop
      // present, exactly once, nothing foreign. Anything less would silently
      // leave a stop without a sequence (or worse, renumber a drop belonging to
      // another Surat Jalan, which RLS would not necessarily catch because a
      // dispatcher legitimately holds both trips' locations).
      const seen = new Set<string>();
      for (const stop of dto.stops) {
        if (!existingIds.has(stop.dropId)) {
          throw new BadRequestException({
            code: ERR_VALIDATION,
            message: `Drop ${stop.dropId} does not belong to Surat Jalan ${sjId}`,
          });
        }
        if (seen.has(stop.dropId)) {
          throw new BadRequestException({
            code: ERR_VALIDATION,
            message: `Drop ${stop.dropId} appears more than once in the route`,
          });
        }
        seen.add(stop.dropId);
      }
      if (seen.size !== existingIds.size) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Route must list every drop exactly once (expected ${existingIds.size}, got ${seen.size})`,
        });
      }

      // TWO-PASS RENUMBER. `sj_drops` has UNIQUE (sj_id, drop_seq) and the
      // constraint is checked per-statement, not deferred to COMMIT — so a
      // straight "set each drop to its new seq" collides the moment two stops
      // swap places (the first UPDATE tries to take a seq the second still
      // holds). Parking everything in a disjoint high range first guarantees no
      // intermediate collision, whatever permutation was asked for.
      //
      // The offset is applied to the CURRENT seq (not the new one) so the
      // parking values are unique by construction. Making the constraint
      // DEFERRABLE would also work but is a schema change to a table three
      // migrations have already had to correct; two statements here are cheaper
      // and affect nothing else.
      const PARK_OFFSET = 1000;
      await client.query(`UPDATE sj_drops SET drop_seq = drop_seq + $2 WHERE sj_id = $1`, [
        sjId,
        PARK_OFFSET,
      ]);

      for (const [index, stop] of dto.stops.entries()) {
        await client.query(
          `UPDATE sj_drops
              SET drop_seq = $3,
                  delivery_instructions = COALESCE($4, delivery_instructions)
            WHERE sj_id = $1 AND id = $2`,
          [sjId, stop.dropId, index + 1, stop.deliveryInstructions ?? null],
        );
      }

      // Belt-and-braces: if any drop is still parked, the permutation check
      // above and this loop disagreed, and committing would leave the route
      // numbered from 1001. Fail loudly inside the transaction instead.
      const stranded = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM sj_drops WHERE sj_id = $1 AND drop_seq > $2`,
        [sjId, PARK_OFFSET],
      );
      if (Number(stranded.rows[0]?.count ?? 0) > 0) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: 'Route renumbering left stops unsequenced — no changes were saved',
        });
      }

      return { sjId, stops: dto.stops.length };
    });
  }

  /**
   * Update ONE stop's delivery brief without touching the order.
   *
   * Deliberately allowed later in the lifecycle than `planRoute`: a dispatcher
   * who learns mid-route that the Balikpapan outlet's front gate is blocked
   * should be able to tell the driver, and that changes no physical loading
   * assumption. Blocked only once the drop itself is finished, where a note
   * would be rewriting history rather than guiding a delivery.
   */
  async setInstructions(client: PoolClient, dropId: UUID, instructions: string | null) {
    return withWrite(client, async () => {
      const drop = await client.query<{ status: string }>(
        `SELECT status FROM sj_drops WHERE id = $1 FOR UPDATE`,
        [dropId],
      );
      const row = drop.rows[0];
      if (!row)
        throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Drop ${dropId} not found` });
      if (
        row.status === 'completed' ||
        row.status === 'completed_discrepancy' ||
        row.status === 'failed'
      ) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} is already ${row.status} — its delivery brief can no longer be changed`,
        });
      }
      await client.query(`UPDATE sj_drops SET delivery_instructions = $2 WHERE id = $1`, [
        dropId,
        instructions,
      ]);
      return { dropId, deliveryInstructions: instructions };
    });
  }
}
