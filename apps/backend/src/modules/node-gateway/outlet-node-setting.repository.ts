/**
 * Per-outlet node-enabled setting (BUILD-PLAN D-26, owner-decided — "the
 * branch node becomes a per-outlet, Owner-only setting"). Reads/writes
 * `locations.settings->>'nodeEnabled'` (CONTRACTS.md §0's settings/payloads
 * JSONB convention, D-10) rather than a new column: `locations` already
 * carries a `settings JSONB NOT NULL DEFAULT '{}'` column (migration 002)
 * with room for exactly this kind of per-location flag, and this ticket's
 * own constraint is "schema changes go to W1-C by request — never write to
 * database/ yourself." A single boolean this existing column already holds
 * does not warrant that request.
 *
 * Default is OFF — an absent key or explicit `false` both read as disabled
 * (RISK-P5: the hardware-free deployment is the default per-outlet state).
 * `locations` itself is M03 `location`'s table, not this module's, but nothing
 * prevents cross-module SQL against it — `NodesController.register` already
 * reads `locations` directly for the plain `{id, code, name}` lookup at
 * pairing time; this repository does the same for one more column.
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import type { DbClient } from '../../kernel/sync/sync-events.repository';

export interface OutletNodeSettingRow {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  is_active: boolean;
  node_enabled: boolean;
}

const SELECT = `
  SELECT id, code, name, type, is_active,
         COALESCE((settings->>'nodeEnabled')::boolean, false) AS node_enabled
    FROM locations
`;

@Injectable()
export class OutletNodeSettingRepository {
  async find(client: DbClient, locationId: UUID): Promise<OutletNodeSettingRow | undefined> {
    const res = await client.query<OutletNodeSettingRow>(`${SELECT} WHERE id = $1`, [locationId]);
    return res.rows[0];
  }

  /** `locations_update` RLS (migration 009) already restricts this write to `owner`/`manager` at the
   *  session-role level; the controller enforces the STRICTER "Owner-only" business rule from D-26
   *  on top of that (RLS is the outer bound, never the only gate — same layering CONTRACTS.md §1.14
   *  describes for every other table). */
  async setEnabled(
    client: DbClient,
    locationId: UUID,
    enabled: boolean,
  ): Promise<OutletNodeSettingRow | undefined> {
    const res = await client.query<OutletNodeSettingRow>(
      `UPDATE locations
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{nodeEnabled}', to_jsonb($2::boolean), true)
        WHERE id = $1
        RETURNING id, code, name, type, is_active,
                  COALESCE((settings->>'nodeEnabled')::boolean, false) AS node_enabled`,
      [locationId, enabled],
    );
    return res.rows[0];
  }
}
