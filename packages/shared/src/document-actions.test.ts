import { describe, expect, it } from 'vitest';
import { ApprovalDocumentType, OpnameStatus, ReplenishmentStatus, isOpnameEditable } from './enums';
import { APPROVAL_TRANSITIONS, actionsFrom } from './approvals/state-machine';

/**
 * WHAT A DOCUMENT ALLOWS IN EACH STATE, AND WHETHER THE SCREENS AGREE.
 *
 * ── THE CLASS OF DEFECT THIS EXISTS FOR ─────────────────────────────────────
 * Three of the bugs a real user found were the same mistake: a screen offered
 * an action the server would refuse, so the person clicked it and got an error
 * they could do nothing about.
 *
 *   * Both count sheets rendered their inputs and their Simpan/Ajukan buttons
 *     for ANY status, showing the status as a badge and nothing else, while
 *     `StockOpnameService` refuses lines and submits on anything but
 *     `counting`. A submitted count could be edited and re-submitted.
 *   * The approvals detail view offered Setujui whenever the caller held the
 *     document type's approve permission — an any-of over EVERY step's role —
 *     so a Supervisor who had cleared step 1 was offered step 2, the
 *     warehouse's.
 *   * "Jadikan PR" stayed enabled on an outlet request already being
 *     fulfilled.
 *
 * Every one of them was a screen answering "what can be done to this document
 * now" by itself, from a permission or from nothing, instead of from the table
 * that the services enforce. `APPROVAL_TRANSITIONS` is CONTRACTS.md §5 written
 * down once; `actionsFrom` reads it. A gate that disagrees with it is a bug in
 * waiting, and this file is where that disagreement shows up.
 *
 * ── WHY THE FIRST TEST SPELLS THE TABLE OUT ─────────────────────────────────
 * It looks redundant — it restates rules that live twenty lines away. It is
 * not: it turns an invisible edit into a failing test. Adding a rule, or
 * changing a `from:`, changes what every screen is allowed to offer, and this
 * is the one place that says so out loud. It is also the only readable index of
 * "what states does this document even have", which is the question you need
 * answered before you can review a screen at all.
 */

/** Documents whose statuses are enumerated in `enums.ts` and driven by a UI. */
describe('the actions each state permits', () => {
  it('stock opname: entry closes the moment it is submitted', () => {
    expect(actionsFrom(ApprovalDocumentType.STOCK_OPNAME, OpnameStatus.DRAFT)).toEqual(['cancel']);
    expect(
      [...actionsFrom(ApprovalDocumentType.STOCK_OPNAME, OpnameStatus.COUNTING)].sort(),
    ).toEqual(['cancel', 'submit']);
    expect(
      [...actionsFrom(ApprovalDocumentType.STOCK_OPNAME, OpnameStatus.SUBMITTED)].sort(),
    ).toEqual(['approve', 'reject']);
    // Nothing further: an adjusted count has posted to the ledger, and a
    // rejected or cancelled one is closed.
    for (const terminal of [OpnameStatus.ADJUSTED, OpnameStatus.REJECTED, OpnameStatus.CANCELLED]) {
      expect(actionsFrom(ApprovalDocumentType.STOCK_OPNAME, terminal), terminal).toEqual([]);
    }
  });

  it('replenishment: the walk from an outlet asking to the outlet receiving', () => {
    const at = (s: ReplenishmentStatus) =>
      [...actionsFrom(ApprovalDocumentType.REPLENISHMENT_REQUEST, s)].sort();

    expect(at(ReplenishmentStatus.DRAFT)).toEqual(['delete']);
    expect(at(ReplenishmentStatus.SUBMITTED)).toEqual(['approve', 'reject']);
    expect(at(ReplenishmentStatus.AWAITING_APPROVAL)).toEqual(['approve', 'reject']);
    // `process` is what a Surat Jalan being marked ready does — which is why an
    // approved request disappears from the Surat Jalan picker once it has one,
    // and the client asked whether that was a bug. It is the contract.
    expect(at(ReplenishmentStatus.APPROVED)).toEqual(['process']);
    expect(at(ReplenishmentStatus.PROCESSING)).toEqual(['dispatch']);
    expect(at(ReplenishmentStatus.SHIPPED)).toEqual(['receive']);
    expect(at(ReplenishmentStatus.RECEIVED)).toEqual(['auto_complete']);
    expect(at(ReplenishmentStatus.COMPLETED)).toEqual([]);
    expect(at(ReplenishmentStatus.REJECTED)).toEqual([]);
  });

  it('purchase request: editable while draft, convertible only once approved', () => {
    const at = (s: string) => [...actionsFrom(ApprovalDocumentType.PURCHASE_REQUEST, s)].sort();

    expect(at('draft')).toEqual(['submit']);
    expect(at('submitted')).toEqual(['approve', 'reject']);
    expect(at('approved')).toEqual(['convert']);
    expect(at('converted')).toEqual([]);
  });

  it('every rule names a state some rule can reach, or an opening state', () => {
    // A `from:` nothing produces is a rule that can never fire — a typo in a
    // status string looks exactly like this and is otherwise silent.
    //
    // The seeds are the states a document can be CREATED in, which the §5
    // table deliberately does not model: it describes decisions taken on
    // documents, not the insert that brings one into being. `counting` is one
    // of them — `StockOpnameRepository.insertOpname` writes `'counting'`
    // directly, which is why a stock opname has no `draft` in practice and no
    // rule produces `counting`.
    const OPENING_STATES = ['(none)', 'draft', 'counting'];
    const reachable = new Set<string>(OPENING_STATES);
    for (const r of APPROVAL_TRANSITIONS) reachable.add(r.to);

    const orphans = APPROVAL_TRANSITIONS.filter((r) => !reachable.has(r.from)).map(
      (r) => `${r.documentType}: from '${r.from}' (${r.action})`,
    );
    expect([...new Set(orphans)], 'these rules can never fire').toEqual([]);
  });
});

/**
 * The screens' own gates, checked against the table above.
 *
 * One entry per gate function that decides whether a document is still open to
 * a user. Anything a screen decides for itself belongs here — that is the whole
 * point, and an empty list would mean the screens went back to guessing.
 */
describe('UI gates agree with the contract', () => {
  it('isOpnameEditable is exactly "submit is still possible"', () => {
    // The gate both count sheets use. It first read `counting || draft`, which
    // disagreed with the table — `draft` permits `cancel` and nothing else —
    // and would have put live inputs and a Simpan button on a document the
    // server refuses to accept lines for.
    for (const status of Object.values(OpnameStatus)) {
      const submitPossible = actionsFrom(ApprovalDocumentType.STOCK_OPNAME, status).includes(
        'submit',
      );
      expect(
        isOpnameEditable(status),
        `isOpnameEditable(${status}) disagrees with the §5 table`,
      ).toBe(submitPossible);
    }
  });
});
