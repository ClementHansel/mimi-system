import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  DocumentPrefix,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  formatCloudDocNumber,
  type ApprovalDetail,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../../kernel/approvals';
import { pgDateToIso } from '../pg-date.util';
import type { CreateLoanDto } from '../dto/payroll.dto';
import { withWrite } from '../db-tx';

export interface LoanApi {
  id: UUID;
  loanNumber: string;
  employeeName: string;
  principal: Money;
  monthlyInstallment: Money;
  outstanding: Money;
  status: string;
  approval?: ApprovalDetail | null;
}

/**
 * M15 `payroll` — employee loans / kasbon (POUT-06). Approval chain per
 * CONTRACTS §5.7 / migration 069's seed: Finance -> Manager. Disbursement
 * posts a `payment_verifications` row (pending) on final approval — the
 * `employee_loan` ref_type CONTRACTS §6.3 mentions for the GL leg is not a
 * valid `payment_verifications.ref_type` per the actual CHECK constraint
 * (migration 094 only allows `'purchase_order'|'payroll_run'|'petty_cash'|
 * 'maintenance_job'|'sale_payment'|'online_order'|'incentive'|'thr'|'other'`)
 * — flagged as a schema/contract discrepancy in this agent's report; `'other'`
 * is used here rather than improvising a DDL change.
 */
@Injectable()
export class LoansService {
  constructor(private readonly approvals: ApprovalService) {}

  async list(client: PoolClient, employeeId: string | undefined, status: string | undefined, page = 1, pageSize = 50): Promise<Paginated<LoanApi>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (employeeId) { params.push(employeeId); where += ` AND l.employee_id = $${params.length}`; }
    if (status) { params.push(status); where += ` AND l.status = $${params.length}`; }

    const countRes = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM employee_loans l WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<Record<string, any>>(
      `SELECT l.*, e.name AS employee_name FROM employee_loans l JOIN employees e ON e.id = l.employee_id
        WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows: res.rows.map(this.mapLoan), total, page, pageSize };
  }

  async create(client: PoolClient, actorUserId: UUID, dto: CreateLoanDto): Promise<LoanApi> {
    if (Number(dto.principal) <= 0) throw new BadRequestException({ code: ERR_VALIDATION, message: 'principal must be positive' });

    const empRes = await client.query('SELECT id FROM employees WHERE id = $1', [dto.employeeId]);
    if (empRes.rows.length === 0) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Employee not found' });

    return withWrite(client, async () => {
      const loanNumber = await this.nextLoanNumber(client);
      const res = await client.query<Record<string, any>>(
        `INSERT INTO employee_loans (loan_number, employee_id, principal, monthly_installment, outstanding, reason)
         VALUES ($1,$2,$3,$4,$3,$5) RETURNING *`,
        [loanNumber, dto.employeeId, dto.principal, dto.monthlyInstallment, dto.reason ?? null],
      );
      const loanId = res.rows[0]!.id as UUID;

      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId: loanId,
        requestedBy: actorUserId,
        amount: dto.principal,
        locationId: null,
      });
      await client.query('UPDATE employee_loans SET approval_id = $2 WHERE id = $1', [loanId, submitResult.approvalId]);

      return this.getById(client, loanId);
    });
  }

  async approve(client: PoolClient, actorUserId: UUID, actorRole: string, id: UUID, note: string | undefined): Promise<LoanApi> {
    const loan = await this.requireLoan(client, id);
    if (loan.status !== 'pending') throw new ConflictException({ code: ERR_CONFLICT, message: `Loan must be 'pending' to approve (currently '${loan.status}')` });

    return withWrite(client, async () => {
      const result = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId: id,
        currentState: loan.status,
        actorUserId,
        actorRole: actorRole as any,
        reason: note ?? null,
      });

      if (result.currentStep === null && result.approvalState === 'approved') {
        await client.query(`UPDATE employee_loans SET status = 'active', approved_by = $2, disbursed_at = NOW() WHERE id = $1`, [id, actorUserId]);

        const pvNumber = await this.nextPvNumber(client);
        // See class header — 'employee_loan' is not a valid `ref_type` under the current CHECK
        // constraint; 'other' is used deliberately, not as an oversight.
        await client.query(
          `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, submitted_by, notes)
           VALUES ($1,'other',$2,'employee',$3,$4,$5,$6)`,
          [pvNumber, id, loan.employeeId, loan.principal, actorUserId, `Pencairan pinjaman karyawan ${loan.loanNumber}`],
        );
      }

      return this.getById(client, id);
    });
  }

  async reject(client: PoolClient, actorUserId: UUID, actorRole: string, id: UUID, reason: string): Promise<LoanApi> {
    if (!reason?.trim()) throw new BadRequestException({ code: ERR_VALIDATION, message: 'reason is required' });
    const loan = await this.requireLoan(client, id);
    if (loan.status !== 'pending') throw new ConflictException({ code: ERR_CONFLICT, message: `Loan must be 'pending' to reject (currently '${loan.status}')` });

    return withWrite(client, async () => {
      await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId: id,
        currentState: loan.status,
        actorUserId,
        actorRole: actorRole as any,
        reason,
      });
      await client.query(`UPDATE employee_loans SET status = 'rejected' WHERE id = $1`, [id]);
      return this.getById(client, id);
    });
  }

  async schedule(client: PoolClient, id: UUID): Promise<{ rows: { paidAt: string; amount: Money; method: string; payrollRunNumber: string | null }[]; outstanding: Money }> {
    const loan = await this.requireLoan(client, id);
    const res = await client.query<Record<string, any>>(
      `SELECT elp.*, r.run_number FROM employee_loan_payments elp
         LEFT JOIN payroll_lines pl ON pl.id = elp.payroll_line_id
         LEFT JOIN payroll_runs r ON r.id = pl.run_id
        WHERE elp.loan_id = $1 ORDER BY elp.paid_at DESC`,
      [id],
    );
    return {
      rows: res.rows.map((r) => ({ paidAt: new Date(r.paid_at).toISOString(), amount: r.amount, method: r.method, payrollRunNumber: r.run_number ?? null })),
      outstanding: loan.outstanding,
    };
  }

  private async getById(client: PoolClient, id: UUID): Promise<LoanApi> {
    const res = await client.query<Record<string, any>>(
      'SELECT l.*, e.name AS employee_name FROM employee_loans l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1',
      [id],
    );
    if (res.rows.length === 0) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Loan not found' });
    const row = this.mapLoan(res.rows[0]!);
    if (res.rows[0]!.approval_id) {
      try {
        const detail = await this.approvals.getDetail(client, ApprovalDocumentType.EMPLOYEE_LOAN, id);
        row.approval = {
          approvalId: detail.approvalId,
          state: detail.state,
          amount: detail.amount,
          steps: detail.steps.map((s) => ({
            stepNo: s.stepNo, approverRole: s.approverRole, state: s.state, actedBy: s.actedBy, actedAt: s.actedAt,
            reason: s.reason, offlineAuthorized: s.offlineAuthorized, reverificationStatus: s.reverificationStatus,
          })),
        } as ApprovalDetail;
      } catch {
        row.approval = null;
      }
    }
    return row;
  }

  private async requireLoan(client: PoolClient, id: UUID): Promise<{ id: UUID; loanNumber: string; employeeId: UUID; status: string; principal: Money; outstanding: Money }> {
    const res = await client.query<Record<string, any>>('SELECT * FROM employee_loans WHERE id = $1', [id]);
    if (res.rows.length === 0) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Loan not found' });
    const r = res.rows[0]!;
    return { id: r.id, loanNumber: r.loan_number, employeeId: r.employee_id, status: r.status, principal: r.principal, outstanding: r.outstanding };
  }

  private async nextLoanNumber(client: PoolClient): Promise<string> {
    const period = pgDateToIso(new Date()).slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('LOAN', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('LOAN', period, res.rows[0]!.last_number);
  }

  private async nextPvNumber(client: PoolClient): Promise<string> {
    const period = pgDateToIso(new Date()).slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.PAYMENT_VERIFICATION, period],
    );
    return formatCloudDocNumber(DocumentPrefix.PAYMENT_VERIFICATION, period, res.rows[0]!.last_number);
  }

  private mapLoan = (r: Record<string, any>): LoanApi => ({
    id: r.id,
    loanNumber: r.loan_number,
    employeeName: r.employee_name,
    principal: r.principal,
    monthlyInstallment: r.monthly_installment,
    outstanding: r.outstanding,
    status: r.status,
  });
}
