/**
 * Internal (staff-to-staff) chat — live database.
 *
 * These tests exist to pin the SECURITY-CRITICAL claims in migration 243's
 * header and this ticket: membership, not location or role tier, decides
 * who can read a conversation; only a group's admin may rename it or
 * manage its membership; a member may only ever remove THEMSELVES; and a
 * direct conversation cannot be duplicated even when both sides race to
 * open it. Every "cannot" assertion below expects a REJECTION, not merely
 * the absence of a success response — a bug that silently no-ops instead
 * of throwing would pass a weaker test and still be a real hole.
 *
 * `withRollback`/`switchActor` (borrowed from `pos/test-support/live-db`,
 * same reasoning as `chat.integration.spec.ts` above) run every actor
 * change on the SAME connection/transaction so a later actor can see an
 * earlier actor's uncommitted writes — exactly what two real, separate HTTP
 * requests achieve in production once the first has committed, simulated
 * here so the whole scenario rolls back together at the end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InternalChatService } from './internal-chat.service';
import {
  closePool,
  getOwnerPool,
  loadOutletFixture,
  switchActor,
  withRollback,
  type OutletFixture,
} from '../pos/test-support/live-db';

vi.setConfig({ testTimeout: 30_000 });

let fx: OutletFixture;

/**
 * A THIRD non-central identity, distinct from `fx.kasirId`/`fx.supervisorId`.
 * Needed because `owner`/`manager` are `app_is_central()` roles that can see
 * every conversation by convention (243's header) — using one of them as the
 * "unauthorized outsider" in a membership test would pass even if membership
 * scoping were completely broken, proving nothing. A second seeded kasir is
 * a genuine outsider: no shared location claim is even consulted (internal
 * conversations carry no location at all), no membership, no central role.
 */
async function anotherActiveUser(
  roleKey: string,
  excludeIds: string[],
): Promise<{ id: string; name: string }> {
  const res = await getOwnerPool().query<{ id: string; name: string }>(
    `SELECT u.id, u.name FROM users u
       JOIN roles r ON r.id = u.role_id AND r.key = $1
      WHERE u.is_active AND u.id <> ALL($2::uuid[])
      ORDER BY u.username
      LIMIT 1`,
    [roleKey, excludeIds],
  );
  if (!res.rows[0]) {
    throw new Error(
      `Seed data needs a second active '${roleKey}' distinct from the fixture's own.`,
    );
  }
  return res.rows[0];
}

describe.skipIf(!process.env.DATABASE_URL)('InternalChatService — live database', () => {
  beforeAll(async () => {
    fx = await loadOutletFixture();
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  it("a non-participant cannot read a group's messages", async () => {
    await withRollback(
      { userId: fx.supervisorId, roleKey: 'supervisor', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const outsider = await anotherActiveUser('kasir', [fx.kasirId, fx.supervisorId]);

        const group = await service.createGroup(client, fx.supervisorId, 'Shift Pagi', [
          fx.kasirId,
        ]);
        await service.sendMessage(client, fx.supervisorId, group.id, 'Jangan lupa opname jam 6');

        await switchActor(client, { userId: outsider.id, roleKey: 'kasir', locationIds: [] });

        await expect(service.getMessages(client, outsider.id, group.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );

        // And the outsider's own inbox never lists it either.
        const mine = await service.listMine(client, outsider.id);
        expect(mine.find((c) => c.id === group.id)).toBeUndefined();
      },
    );
  });

  it('a non-admin member cannot add or remove members', async () => {
    await withRollback(
      { userId: fx.supervisorId, roleKey: 'supervisor', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const target = await anotherActiveUser('kasir', [fx.kasirId, fx.supervisorId]);

        // Creator (fx.supervisorId) is seeded 'admin'; fx.kasirId joins as
        // a plain 'member'.
        const group = await service.createGroup(client, fx.supervisorId, 'Kru Outlet', [
          fx.kasirId,
        ]);

        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });

        await expect(
          service.addMember(client, fx.kasirId, group.id, target.id),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.removeMember(client, fx.kasirId, group.id, fx.supervisorId),
        ).rejects.toBeInstanceOf(ForbiddenException);

        // The admin, by contrast, genuinely can — proves the rejection above
        // is about ROLE, not the action being broken outright.
        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        await expect(
          service.addMember(client, fx.supervisorId, group.id, target.id),
        ).resolves.toBeUndefined();
      },
    );
  });

  it('leaving a group hides it from your own list but not from the members who remain', async () => {
    await withRollback(
      { userId: fx.supervisorId, roleKey: 'supervisor', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const group = await service.createGroup(client, fx.supervisorId, 'Akan Ditinggalkan', [
          fx.kasirId,
        ]);

        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        await service.leaveGroup(client, fx.kasirId, group.id);

        const kasirsList = await service.listMine(client, fx.kasirId);
        expect(kasirsList.find((c) => c.id === group.id)).toBeUndefined();

        // A departed member also loses read access outright, not just the
        // list entry — leaving is a real membership change, not a UI filter.
        await expect(service.getMessages(client, fx.kasirId, group.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );

        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const supervisorsList = await service.listMine(client, fx.supervisorId);
        expect(supervisorsList.find((c) => c.id === group.id)).toBeDefined();
      },
    );
  });

  it('the sole admin leaving promotes the longest-standing remaining member, so the group is never left without one', async () => {
    await withRollback(
      { userId: fx.supervisorId, roleKey: 'supervisor', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const group = await service.createGroup(client, fx.supervisorId, 'Admin Tunggal', [
          fx.kasirId,
        ]);

        // fx.supervisorId is the only admin; it leaves.
        await service.leaveGroup(client, fx.supervisorId, group.id);

        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        const detail = await service.getDetail(client, fx.kasirId, group.id);
        expect(detail.participants.find((p) => p.userId === fx.kasirId)?.role).toBe('admin');

        // And the promoted member can now exercise admin actions.
        const target = await anotherActiveUser('kasir', [fx.kasirId, fx.supervisorId]);
        await expect(
          service.addMember(client, fx.kasirId, group.id, target.id),
        ).resolves.toBeUndefined();
      },
    );
  });

  it('a direct conversation is not duplicated when both people open it — including a same-instant race', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();

        const fromKasir = await service.openDirect(client, fx.kasirId, fx.supervisorId);

        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const fromSupervisor = await service.openDirect(client, fx.supervisorId, fx.kasirId);
        expect(fromSupervisor.id).toBe(fromKasir.id);

        // Racing the SAME direction concurrently must also converge on one
        // row — this is exactly what the `direct_key` unique index (243)
        // exists to guarantee, not a check-then-insert in the service.
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        const [a, b] = await Promise.all([
          service.openDirect(client, fx.kasirId, fx.supervisorId),
          service.openDirect(client, fx.kasirId, fx.supervisorId),
        ]);
        expect(a.id).toBe(fromKasir.id);
        expect(b.id).toBe(fromKasir.id);
      },
    );
  });

  it("a message sent by one side is readable by the other, and marking read zeroes only the reader's own unread count", async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const convo = await service.openDirect(client, fx.kasirId, fx.supervisorId);
        await service.sendMessage(client, fx.kasirId, convo.id, 'Halo, ada waktu?');

        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const supervisorsList = await service.listMine(client, fx.supervisorId);
        expect(supervisorsList.find((c) => c.id === convo.id)?.unreadCount).toBe(1);

        await service.markRead(client, fx.supervisorId, convo.id);
        const afterRead = await service.listMine(client, fx.supervisorId);
        expect(afterRead.find((c) => c.id === convo.id)?.unreadCount).toBe(0);

        // The SENDER's own copy was never "unread" in the first place —
        // marking the reader's cursor must not have touched it.
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        const kasirsList = await service.listMine(client, fx.kasirId);
        expect(kasirsList.find((c) => c.id === convo.id)?.unreadCount).toBe(0);
      },
    );
  });

  it('a non-member cannot send a message even when the conversation itself is reachable', async () => {
    await withRollback(
      { userId: fx.supervisorId, roleKey: 'supervisor', locationIds: [fx.locationId] },
      async (client) => {
        const service = new InternalChatService();
        const outsider = await anotherActiveUser('kasir', [fx.kasirId, fx.supervisorId]);
        const group = await service.createGroup(client, fx.supervisorId, 'Tertutup', [fx.kasirId]);

        await switchActor(client, { userId: outsider.id, roleKey: 'kasir', locationIds: [] });
        await expect(
          service.sendMessage(client, outsider.id, group.id, 'ikut dong'),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );
  });
});
