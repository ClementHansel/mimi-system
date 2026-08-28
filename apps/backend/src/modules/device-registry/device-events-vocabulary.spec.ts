import { describe, expect, it } from 'vitest';
import { AUTHORITY } from '@mimi/sync-protocol';
import { SyncEntity, DeviceEventType } from '@mimi/shared';

/**
 * D-15 — the two `device_events` vocabularies, pinned.
 *
 * `device_events.type` (the DB CHECK, migrations 113/258, mirrored by
 * `DeviceEventType`) and `AUTHORITY[DEVICE_EVENTS].ops` (the wire op
 * vocabulary) look like they should be the same list and are not. They share
 * three values and disagree on the rest, and several pairs are the SAME
 * concept under different names — `online`/`went_online`,
 * `offline`/`went_offline`, `clock_skew`/`clock_suspect`.
 *
 * That is deliberate: the DB column is a local audit log of what happened to a
 * device, written by the cloud; the op is the fact that crosses the wire. The
 * emit sites write BOTH, with different values, on purpose — see
 * `devices.controller.ts`'s heartbeat-recovery branch, which inserts
 * `type: 'online'` and emits `op: 'went_online'` two lines apart.
 *
 * The reason this needs a test rather than a comment is the failure mode. An
 * op that is emitted but NOT declared in the authority matrix fails schema
 * validation inside `SyncEmitService.emit()`, and every call site catches that
 * rejection because a telemetry mirror must never fail a heartbeat ack. So the
 * event simply never happens — deterministically, forever, with no error
 * anywhere. That is exactly what D-15 was: `outlet_offline`/`outlet_online`
 * were emitted for a long time without being declared, and it took a soak spec
 * to notice.
 *
 * Anyone "tidying up" by aligning the two lists, or adding an emit for a new
 * op without declaring it, fails here instead of shipping silence.
 */
describe('D-15 — device_events: DB type vocabulary vs wire op vocabulary', () => {
  /**
   * Every `op` this codebase actually emits for `device_events`, from the six
   * `entity: 'device_events'` emit sites (`devices.controller.ts`,
   * `staleness-sweep.service.ts` x4, `bridge.gateway.ts`).
   *
   * Maintained by hand on purpose: a static scan of the source would drift
   * into parsing TypeScript, and the point of the list is that adding an emit
   * makes someone come here and think about the declaration.
   */
  const EMITTED_OPS = [
    'went_online',
    'went_offline',
    'stale',
    'outlet_offline',
    'outlet_online',
  ] as const;

  // `AUTHORITY` is a partial record over `SyncEntity`. The entry's existence
  // is asserted by the first test below rather than here — an `expect` in the
  // describe body runs at COLLECTION time, where a failure reports as a suite
  // load error instead of a named failing test.
  const entry = AUTHORITY[SyncEntity.DEVICE_EVENTS];
  const declared = entry?.ops ?? [];

  it('every op the codebase emits is declared in the authority matrix', () => {
    expect(entry, 'device_events must be declared in the authority matrix').toBeDefined();
    const undeclared = EMITTED_OPS.filter((op) => !declared.includes(op));
    expect(
      undeclared,
      'these ops would fail schema validation and be silently swallowed at every emit site',
    ).toEqual([]);
  });

  it('the DB type vocabulary and the wire op vocabulary are deliberately different', () => {
    const dbTypes = Object.values(DeviceEventType) as string[];

    // Not a tautology: it asserts the two lists have NOT been quietly merged.
    // If someone aligns them, the emit sites that write `type: 'online'` and
    // `op: 'went_online'` together stop making sense and this fails, sending
    // them to the comment above rather than letting a rename land.
    const shared = declared.filter((op) => dbTypes.includes(op));
    expect([...shared].sort()).toEqual(['outlet_offline', 'outlet_online', 'stale']);

    // The same-concept-different-name pairs, named explicitly so a rename on
    // either side is a failing test rather than a silent divergence.
    for (const [dbType, wireOp] of [
      ['online', 'went_online'],
      ['offline', 'went_offline'],
    ] as const) {
      expect(dbTypes).toContain(dbType);
      expect(declared).toContain(wireOp);
    }
  });

  it('every declared pushOp is also a declared op', () => {
    // A device may only push what the entity declares; a pushOp outside `ops`
    // would be accepted by one check and rejected by the other.
    const pushOps = entry?.pushOps ?? [];
    expect(pushOps.filter((op) => !declared.includes(op))).toEqual([]);
  });
});
