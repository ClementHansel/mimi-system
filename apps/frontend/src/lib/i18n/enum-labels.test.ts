import { describe, expect, it } from 'vitest';
import {
  PaymentVerificationRefType,
  PayeeType,
  ReplenishmentStatus,
  ApprovalDocumentType,
} from '@mimi/shared';
import { translate } from './index';

/**
 * EVERY MEMBER OF AN ENUM THE UI LABELS MUST HAVE A LABEL.
 *
 * The gap this closes, found on Finance's payments screen 2026-09-01:
 * `PaymentVerificationRefType.EMPLOYEE_LOAN` was added with migration 259
 * (D-17, kasbon disbursement) and no `finance.refType.employee_loan` string.
 * Screens build these keys by TEMPLATE — `t(\`finance.refType.${r.refType}\`)` —
 * so nothing referenced the missing key literally, `literal-keys.test.ts`
 * could not see it, and `translate()` returns THE KEY on a miss. Finance's
 * table, its filter dropdown and its detail drawer all read
 * `finance.refType.employee_loan` in production, where the `console.warn`
 * beside that return is compiled out.
 *
 * `doc-keys.test.ts` does exactly this job for the document-template catalog.
 * This is the same discipline for the enums the operational screens label, and
 * it is the only thing that makes adding an enum member fail loudly at home
 * instead of quietly on a user's screen. When a new enum starts being rendered
 * through a template key, add it here.
 */

const CASES: { name: string; prefix: string; members: readonly string[] }[] = [
  {
    name: 'PaymentVerificationRefType',
    prefix: 'finance.refType',
    members: Object.values(PaymentVerificationRefType),
  },
  {
    name: 'PayeeType',
    prefix: 'finance.payeeType',
    members: Object.values(PayeeType),
  },
  {
    name: 'ReplenishmentStatus',
    prefix: 'status.replenishment',
    members: Object.values(ReplenishmentStatus),
  },
  {
    name: 'ApprovalDocumentType',
    prefix: 'approvals.documentType',
    members: Object.values(ApprovalDocumentType),
  },
];

describe.each(CASES)('$name → $prefix.*', ({ prefix, members }) => {
  it('labels every member, with no member left rendering as its own key', () => {
    const missing = members.filter((member) => {
      const key = `${prefix}.${member}`;
      return translate(key) === key;
    });

    expect(
      missing,
      `these enum members have no Indonesian label and will render as a raw key on screen:\n` +
        missing.map((m) => `  ${prefix}.${m}`).join('\n'),
    ).toEqual([]);
  });

  it('has at least one member, so a renamed enum cannot make this vacuous', () => {
    // An `Object.values` that silently became empty would pass the check above
    // while testing nothing — the same vacuous-pass shape that made the e2e
    // tab sweep skip nine areas.
    expect(members.length).toBeGreaterThan(0);
  });
});
