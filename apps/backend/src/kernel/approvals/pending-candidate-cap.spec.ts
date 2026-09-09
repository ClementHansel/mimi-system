import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ApprovalService } from './approvals.service';
import { PENDING_CANDIDATE_CAP, type ApprovalsRepository } from './approvals.repository';

/**
 * THE CANDIDATE CAP MUST NOT FAIL SILENTLY.
 *
 * `findPendingCandidates` fetches at most `PENDING_CANDIDATE_CAP` pending steps
 * `ORDER BY requested_at ASC`, and the service filters by role eligibility and
 * paginates that set in memory — a documented trade-off, because eligibility
 * for the four runtime-resolved chains cannot be expressed as a SQL predicate.
 * Its own comment names the assumption it rests on ("dozens-to-low-hundreds
 * pending approvals system-wide … revisit at NFR-01 load test if that
 * assumption breaks").
 *
 * What was missing was anything that NOTICES the break. Past the cap it is the
 * NEWEST pending steps that fall off — the ones an approver is most likely to
 * be waiting on — and they are then absent from every page while `total`
 * quietly agrees, because both are computed from the truncated set. The
 * response stays well-formed and merely short, which is indistinguishable from
 * a quiet day. On production the day this was written the real number was 24
 * against a cap of 2000, so this is a tripwire for a distant condition, not a
 * live bug — but a distant condition that would be invisible when it arrives is
 * exactly the kind worth instrumenting before it does.
 *
 * A UNIT test with a stubbed repository, deliberately: reproducing the real
 * condition needs 2001 pending approval steps in the database, and a fixture
 * that seeds them would cost minutes per run to assert one boolean. The seam
 * that matters is "repository says truncated -> service says so loudly", and
 * that is exactly what this drives. The other half — that the flag is FALSE and
 * the probe row never leaks into the results under normal volumes — is asserted
 * against the live database in `approvals.integration.spec.ts`.
 */
function serviceWith(truncated: boolean): ApprovalService {
  const repo = {
    // An EMPTY page with `truncated: true` is the honest stub for "the cap cut
    // everything this caller was eligible for": the service's per-type loop
    // never runs, so no other repository method is reached and none needs
    // stubbing. It also proves the warning does not depend on there being rows.
    findPendingCandidates: vi.fn().mockResolvedValue({ rows: [], truncated }),
  } as unknown as ApprovalsRepository;
  return new ApprovalService(repo);
}

const caller = { userId: 'u1', roleKey: 'owner', locationIds: null } as never;
const query = { page: 1, pageSize: 25 } as never;

describe('getPending — the pending-candidate cap is loud when it truncates', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs an ERROR naming the cap when the repository reports truncation', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });

    const page = await serviceWith(true).getPending({} as never, caller, query);

    expect(logged, 'the cap was reached and nothing said so').toHaveLength(1);
    // The message has to carry the number to raise and what the symptom looks
    // like, or whoever finds it in a log at 2am learns nothing actionable.
    expect(logged[0]).toContain(String(PENDING_CANDIDATE_CAP));
    expect(logged[0]).toMatch(/newest pending approvals are being hidden/i);
    expect(logged[0]).toMatch(/PENDING_CANDIDATE_CAP/);

    // …and the response is still well-formed. The signal is for operators; it
    // must never turn a short page into a failed request for the approver.
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('stays silent on the ordinary path, so the signal keeps meaning something', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });

    await serviceWith(false).getPending({} as never, caller, query);

    expect(logged, 'an untruncated fetch logged an error — the alarm is now noise').toEqual([]);
  });
});
