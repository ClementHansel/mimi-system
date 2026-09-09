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
      expect(
        postingRulesFor(eventType).length,
        `no posting rule for JournalEventType.${eventType}`,
      ).toBeGreaterThan(0);
    }
  });

  it('every JournalSystemEventType (D-04 extensions, incl. petty-cash top-up and loan disbursement) has at least one posting rule', () => {
    for (const eventType of Object.values(JournalSystemEventType)) {
      expect(
        postingRulesFor(eventType).length,
        `no posting rule for JournalSystemEventType.${eventType}`,
      ).toBeGreaterThan(0);
    }
  });

  it('has exactly 12 JournalSystemEventType members after adding the three PV-paid postings', () => {
    // 9 → 12: SUPPLIER_PAYMENT, MAINTENANCE_PAYMENT and
    // EMPLOYEE_COMPENSATION_PAYMENT (migration 267). This assertion is the
    // reason the gap got closed in BOTH tables rather than only in the
    // migration — it failed the moment the enum members were added, which is
    // exactly its job.
    expect(Object.values(JournalSystemEventType)).toHaveLength(12);
  });
});

describe('PV `paid` postings that §6 never named (migration 267)', () => {
  /**
   * These are the five `payment_verifications.ref_type` values that posted
   * NOTHING when a voucher was marked paid, because
   * `PaymentVerificationsService.publishPaymentJournal` let them fall into a
   * `default:` that returned silently. Three needed brand-new rules; the other
   * two (`petty_cash`, `employee_loan`) already had rules here and were
   * unreachable behind a `notes` marker no code ever wrote.
   *
   * The supplier case is the one with a running cost: JGUD-01 credits 2000
   * Hutang Supplier at PO receipt and nothing debited it back, so the payable
   * grew monotonically and the bank outflow was never recorded.
   */
  it('SUPPLIER_PAYMENT debits 2000 Hutang Supplier on every paidVia', () => {
    const rules = postingRulesFor(JournalSystemEventType.SUPPLIER_PAYMENT);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(resolvePostingAccount(rule.debitAccountCode, undefined)).toBe('2000');
    }
  });

  it('credits 1000 Kas only for paidVia cash, and 1020 Bank otherwise (QRIS included)', () => {
    for (const eventType of [
      JournalSystemEventType.SUPPLIER_PAYMENT,
      JournalSystemEventType.MAINTENANCE_PAYMENT,
      JournalSystemEventType.EMPLOYEE_COMPENSATION_PAYMENT,
    ]) {
      for (const rule of postingRulesFor(eventType)) {
        const credit = resolvePostingAccount(rule.creditAccountCode, undefined);
        expect(credit).toBe(rule.condition?.paidVia === 'cash' ? '1000' : '1020');
      }
    }
  });

  it('MAINTENANCE_PAYMENT debits 6200, which no other rule in the table touches', () => {
    const rules = postingRulesFor(JournalSystemEventType.MAINTENANCE_PAYMENT);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(resolvePostingAccount(rule.debitAccountCode, undefined)).toBe('6200');
    }
    // 6200 Beban Maintenance was seeded in migration 090 and referenced by NO
    // posting rule, so maintenance cost never reached the P&L in any form.
    // These are the only rules that use it — if that stops being true the
    // duplication is worth a second look, not a silent pass.
    const others = POSTING_RULES.filter(
      (r) =>
        r.eventType !== JournalSystemEventType.MAINTENANCE_PAYMENT &&
        (r.debitAccountCode === '6200' || r.creditAccountCode === '6200'),
    );
    expect(others).toEqual([]);
  });

  it('EMPLOYEE_COMPENSATION_PAYMENT debits 6000 Beban Gaji, not 2100 Hutang Gaji', () => {
    // Insentif/THR are paid outside a payroll run, so there is no X1 accrual
    // against 2100 to settle — debiting the liability would create one that
    // never existed. X2 (PAYROLL_PAYMENT) is the case that DOES debit 2100.
    const rules = postingRulesFor(JournalSystemEventType.EMPLOYEE_COMPENSATION_PAYMENT);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(resolvePostingAccount(rule.debitAccountCode, undefined)).toBe('6000');
    }
    const payrollPayment = postingRulesFor(JournalSystemEventType.PAYROLL_PAYMENT);
    expect(resolvePostingAccount(payrollPayment[0]!.debitAccountCode, undefined)).toBe('2100');
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
    expect(
      loanDisbursement.every((r) => r.eventType !== JournalSystemEventType.PAYROLL_ACCRUAL),
    ).toBe(true);
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
