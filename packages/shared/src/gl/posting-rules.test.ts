import { describe, it, expect } from 'vitest';
import { JournalEventType, JournalSystemEventType } from '../enums';
import { POSTING_RULES, postingRulesFor, resolvePostingAccount } from './posting-rules';

describe('posting-rule coverage — every journal event type has at least one rule', () => {
  // This is the enforced version of the coordinator's "cross-check §6.2/§6.3 against both
  // enums" ask: it fails the moment a JournalEventType/JournalSystemEventType member exists
  // with no posting rule behind it (or, by the same token, catches the next silent gap
  // before a third/fourth party has to rediscover it).
  it('every JournalEventType (the 16 PRD event types) has at least one posting rule', () => {
    for (const eventType of Object.values(JournalEventType)) {
      expect(postingRulesFor(eventType).length, `no posting rule for JournalEventType.${eventType}`).toBeGreaterThan(0);
    }
  });

  it('every JournalSystemEventType (D-04 extensions, incl. petty-cash top-up and loan disbursement) has at least one posting rule', () => {
    for (const eventType of Object.values(JournalSystemEventType)) {
      expect(postingRulesFor(eventType).length, `no posting rule for JournalSystemEventType.${eventType}`).toBeGreaterThan(0);
    }
  });

  it('has exactly 9 JournalSystemEventType members after adding PETTY_CASH_TOPUP / EMPLOYEE_LOAN_DISBURSEMENT', () => {
    expect(Object.values(JournalSystemEventType)).toHaveLength(9);
  });
});

describe('the two newly-added event types (§6.3 closing paragraph)', () => {
  it('PETTY_CASH_TOPUP posts Dr 1010 (Kas Kecil) / Cr 1020 (Bank)', () => {
    const rules = postingRulesFor(JournalSystemEventType.PETTY_CASH_TOPUP);
    expect(rules).toHaveLength(1);
    expect(resolvePostingAccount(rules[0]!.debitAccountCode, undefined)).toBe('1010');
    expect(resolvePostingAccount(rules[0]!.creditAccountCode, undefined)).toBe('1020');
  });

  it('EMPLOYEE_LOAN_DISBURSEMENT posts Dr 1210 (Piutang Karyawan) / Cr 1020 (Bank)', () => {
    const rules = postingRulesFor(JournalSystemEventType.EMPLOYEE_LOAN_DISBURSEMENT);
    expect(rules).toHaveLength(1);
    expect(resolvePostingAccount(rules[0]!.debitAccountCode, undefined)).toBe('1210');
    expect(resolvePostingAccount(rules[0]!.creditAccountCode, undefined)).toBe('1020');
  });

  it('are distinct from the payroll-installment leg already folded into PAYROLL_ACCRUAL', () => {
    const loanDisbursement = postingRulesFor(JournalSystemEventType.EMPLOYEE_LOAN_DISBURSEMENT);
    const payrollAccrual = postingRulesFor(JournalSystemEventType.PAYROLL_ACCRUAL);
    expect(loanDisbursement.every((r) => r.eventType !== JournalSystemEventType.PAYROLL_ACCRUAL)).toBe(true);
    expect(payrollAccrual.length).toBeGreaterThan(0);
  });
});

describe('POSTING_RULES sanity', () => {
  it('every rule resolves to a real account code shape (4-digit string) for the unconditional case', () => {
    for (const rule of POSTING_RULES) {
      if (rule.condition !== null) continue; // conditional selectors are exercised by their own condition-specific tests elsewhere
      expect(resolvePostingAccount(rule.debitAccountCode, undefined)).toMatch(/^\d{4}$/);
      expect(resolvePostingAccount(rule.creditAccountCode, undefined)).toMatch(/^\d{4}$/);
    }
  });
});
