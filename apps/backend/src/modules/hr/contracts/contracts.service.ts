import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  formatCloudDocNumber,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { pgDateToIso } from '../pg-date.util';
import { withWrite } from '../db-tx';
import type {
  CreateContractDto,
  ListContractsQueryDto,
  SignContractDto,
  TerminateContractDto,
  UpdateContractDto,
} from '../dto/contract.dto';

export interface ContractSignature {
  id: UUID;
  contractId: UUID;
  partyType: 'employee' | 'company';
  employeeId: UUID | null;
  userId: UUID | null;
  /** Name of the signer — the employee's or the company signer's, whichever party this row is. */
  signerName: string;
  signedAt: string;
  method: 'wet_ink_scan' | 'digital' | 'in_person_witnessed';
  notes: string | null;
}

export interface EmploymentContract {
  id: UUID;
  contractNumber: string;
  employeeId: UUID;
  employeeName: string;
  employeeNumber: string;
  contractType: 'pkwt' | 'pkwtt' | 'probation' | 'internship';
  position: string;
  locationId: UUID | null;
  locationName: string | null;
  baseSalary: Money | null;
  startDate: string;
  endDate: string | null;
  status: 'draft' | 'active' | 'expired' | 'terminated';
  signedAt: string | null;
  documentAttachmentId: UUID | null;
  terminationReason: string | null;
  notes: string | null;
  /**
   * Days until `end_date`, negative once past. NULL for a permanent contract
   * (PKWTT) and for anything not `active` — a terminated contract has no
   * meaningful countdown, and showing one would imply it still runs.
   */
  daysUntilExpiry: number | null;
  /** Whether the employee's own signature row (migration 252) exists yet. */
  employeeSigned: boolean;
  /** How many distinct company signers have signed so far — can be more than one. */
  companySignerCount: number;
  /**
   * Both required parties have signed. Mirrors EXACTLY the condition the DB
   * trigger `contracts_require_signatures_before_active` (252) checks before
   * allowing `status = 'active'` — computed here for display (e.g. "still
   * needs a company signature" on a draft) rather than trusted as the gate
   * itself, which stays in the database.
   */
  fullySigned: boolean;
}

/**
 * M14 `hr` — employment contracts (kontrak kerja), W7.
 *
 * The one thing this module exists to get right is EXPIRY. An Indonesian PKWT
 * that lapses unnoticed is not a paperwork problem: the employee's legal
 * standing changes, and the company's obligations with it. So:
 *
 *  - `end_date` is mandatory for every fixed-term type and forbidden for PKWTT,
 *    enforced by a CHECK in migration 230 rather than by hope, because an
 *    expiry report is only as good as the rows it reads.
 *  - `daysUntilExpiry` is computed here, once, from the SERVER's WITA today —
 *    never in the browser, where a device with a wrong clock (the same class of
 *    problem SYNC-PROTOCOL §6.4 handles for attendance) would quietly show an
 *    expired contract as fine.
 *  - Expiring contracts are a QUERY (`listExpiring`), not a trigger. Nothing
 *    rewrites `status` behind an HR admin's back; they see what is coming and
 *    decide.
 *
 * No `SyncEmitService`: contracts are desk-only, cloud-authoritative documents
 * with salary on them — the same class as payroll (CONTRACTS §5.3 class X), so
 * they are never wire-eligible.
 */
@Injectable()
export class ContractsService {
  async list(
    client: PoolClient,
    query: ListContractsQueryDto,
  ): Promise<Paginated<EmploymentContract>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const conds: string[] = [];
    const params: unknown[] = [];

    if (query.employeeId) {
      params.push(query.employeeId);
      conds.push(`c.employee_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conds.push(`c.status = $${params.length}`);
    }
    if (query.contractType) {
      params.push(query.contractType);
      conds.push(`c.contract_type = $${params.length}`);
    }
    if (query.expiringWithinDays !== undefined) {
      // Active, dated, and inside the window — a contract that already expired
      // is not "expiring", and a permanent one never is.
      params.push(query.expiringWithinDays);
      conds.push(
        `c.status = 'active' AND c.end_date IS NOT NULL
         AND c.end_date BETWEEN (NOW() AT TIME ZONE 'Asia/Makassar')::date
                            AND ((NOW() AT TIME ZONE 'Asia/Makassar')::date + ($${params.length}::int * INTERVAL '1 day'))`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM employment_contracts c ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0]!.count, 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<Record<string, unknown>>(
      `${SELECT_SQL} ${where}
        ORDER BY c.start_date DESC, c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: res.rows.map((r) => this.map(r)), total, page, pageSize };
  }

  /** The caller's own contracts — the `employee` interface's Kontrak tab. */
  async listOwn(client: PoolClient, userId: UUID): Promise<EmploymentContract[]> {
    const res = await client.query<Record<string, unknown>>(
      `${SELECT_SQL} WHERE e.user_id = $1 ORDER BY c.start_date DESC`,
      [userId],
    );
    return res.rows.map((r) => this.map(r));
  }

  async getById(client: PoolClient, id: UUID): Promise<EmploymentContract> {
    const res = await client.query<Record<string, unknown>>(`${SELECT_SQL} WHERE c.id = $1`, [id]);
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Contract ${id} not found` });
    return this.map(res.rows[0]!);
  }

  async create(
    client: PoolClient,
    actorUserId: UUID,
    dto: CreateContractDto,
  ): Promise<EmploymentContract> {
    this.assertTermMatchesType(dto.contractType, dto.endDate ?? null);

    const emp = await client.query('SELECT id FROM employees WHERE id = $1', [dto.employeeId]);
    if (emp.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Employee not found' });

    return withWrite(client, async () => {
      const contractNumber = await this.nextContractNumber(client);
      const res = await client.query<{ id: string }>(
        `INSERT INTO employment_contracts
           (contract_number, employee_id, contract_type, position, location_id, base_salary,
            start_date, end_date, status, signed_at, document_attachment_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          contractNumber,
          dto.employeeId,
          dto.contractType,
          dto.position,
          dto.locationId ?? null,
          dto.baseSalary ?? null,
          dto.startDate,
          dto.endDate ?? null,
          // A contract is born unsigned (migration 252's trigger refuses
          // `status = 'active'` on INSERT unconditionally — nothing can
          // reference a signature row for a contract that does not exist
          // yet), so the honest default changed from 'active' to 'draft'.
          // An explicit `dto.status` is still respected (and still checked
          // by the trigger) so a caller CAN try 'active' — and correctly get
          // rejected, the same defence-in-depth `assertTermMatchesType`
          // already gives the type/term rule.
          dto.status ?? 'draft',
          dto.signedAt ?? null,
          dto.documentAttachmentId ?? null,
          dto.notes ?? null,
          actorUserId,
        ],
      );
      return this.getById(client, res.rows[0]!.id as UUID);
    });
  }

  async update(client: PoolClient, id: UUID, dto: UpdateContractDto): Promise<EmploymentContract> {
    const existing = await this.getById(client, id);
    if (existing.status === 'terminated') {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: 'A terminated contract cannot be edited — issue a new contract instead',
      });
    }
    // The type/term pair has to stay consistent even when only ONE of the two
    // is being changed, so both are resolved against the existing row first.
    const nextType = dto.contractType ?? existing.contractType;
    const nextEnd = dto.endDate !== undefined ? dto.endDate : existing.endDate;
    this.assertTermMatchesType(nextType, nextEnd);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.contractType !== undefined) set('contract_type', dto.contractType);
    if (dto.position !== undefined) set('position', dto.position);
    if (dto.locationId !== undefined) set('location_id', dto.locationId);
    if (dto.baseSalary !== undefined) set('base_salary', dto.baseSalary);
    if (dto.startDate !== undefined) set('start_date', dto.startDate);
    if (dto.endDate !== undefined) set('end_date', dto.endDate);
    if (dto.status !== undefined) set('status', dto.status);
    if (dto.signedAt !== undefined) set('signed_at', dto.signedAt);
    if (dto.documentAttachmentId !== undefined)
      set('document_attachment_id', dto.documentAttachmentId);
    if (dto.notes !== undefined) set('notes', dto.notes);
    if (sets.length === 0) return existing;

    return withWrite(client, async () => {
      await client.query(
        `UPDATE employment_contracts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
        params,
      );
      return this.getById(client, id);
    });
  }

  /**
   * Ends a contract early. Separate from `update` because it is not an edit: it
   * is a terminal event that needs a reason on the record (the CHECK in 230
   * enforces that), and it must not be reachable by accident from a form that
   * happens to include a status dropdown.
   */
  async terminate(
    client: PoolClient,
    id: UUID,
    dto: TerminateContractDto,
  ): Promise<EmploymentContract> {
    const existing = await this.getById(client, id);
    if (existing.status === 'terminated') {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: `Contract ${existing.contractNumber} is already terminated`,
      });
    }
    return withWrite(client, async () => {
      await client.query(
        `UPDATE employment_contracts
            SET status = 'terminated', termination_reason = $2, end_date = COALESCE($3, end_date, (NOW() AT TIME ZONE 'Asia/Makassar')::date),
                updated_at = NOW()
          WHERE id = $1`,
        [id, dto.reason, dto.endDate ?? null],
      );
      return this.getById(client, id);
    });
  }

  /**
   * Records one party's signature (migration 252). `party: 'employee'`
   * always signs FOR the contract's own employee (there is exactly one, and
   * a caller cannot name a different one — that would let one employee's
   * contract be recorded as signed by another). `party: 'company'` records
   * the ACTOR as the signer — see `ContractsController.sign`'s doc comment
   * for why. Signing does not itself change `status`; a separate `update`
   * (or `create`) call to `status: 'active'` does that, and the DB trigger
   * (252) is what actually enforces both parties are in before it succeeds —
   * this method only ever adds evidence, it never flips the contract live.
   */
  async sign(
    client: PoolClient,
    id: UUID,
    actorUserId: UUID,
    dto: SignContractDto,
  ): Promise<EmploymentContract> {
    const existing = await this.getById(client, id);
    if (existing.status === 'terminated') {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: `Contract ${existing.contractNumber} is terminated — it cannot be signed`,
      });
    }
    return withWrite(client, async () => {
      try {
        if (dto.party === 'employee') {
          await client.query(
            `INSERT INTO contract_signatures
               (contract_id, party_type, employee_id, signed_at, method, notes, created_by)
             VALUES ($1, 'employee', $2, COALESCE($3, NOW()), $4, $5, $6)`,
            [
              id,
              existing.employeeId,
              dto.signedAt ?? null,
              dto.method,
              dto.notes ?? null,
              actorUserId,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO contract_signatures
               (contract_id, party_type, user_id, signed_at, method, notes, created_by)
             VALUES ($1, 'company', $2, COALESCE($3, NOW()), $4, $5, $6)`,
            [id, actorUserId, dto.signedAt ?? null, dto.method, dto.notes ?? null, actorUserId],
          );
        }
      } catch (err) {
        // 23505 = unique_violation — `ux_contract_signatures_employee`/
        // `_company` (252) already refuse a second signature by the same
        // party; caught here for a clear ERR_CONFLICT message rather than a
        // raw Postgres error reaching the client.
        if ((err as { code?: string }).code === '23505') {
          throw new BadRequestException({
            code: ERR_CONFLICT,
            message:
              dto.party === 'employee'
                ? 'The employee has already signed this contract'
                : 'This person has already signed this contract as the company',
          });
        }
        throw err;
      }
      return this.getById(client, id);
    });
  }

  /** Every recorded signature for one contract — who, when, how. RLS (252) scopes this identically to the contract itself. */
  async listSignatures(client: PoolClient, contractId: UUID): Promise<ContractSignature[]> {
    const res = await client.query<Record<string, unknown>>(
      `SELECT s.id, s.contract_id, s.party_type, s.employee_id, s.user_id,
              COALESCE(e.name, u.name) AS signer_name,
              s.signed_at, s.method, s.notes
         FROM contract_signatures s
         LEFT JOIN employees e ON e.id = s.employee_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.contract_id = $1
        ORDER BY s.signed_at ASC`,
      [contractId],
    );
    return res.rows.map((r) => ({
      id: r.id as UUID,
      contractId: r.contract_id as UUID,
      partyType: r.party_type as ContractSignature['partyType'],
      employeeId: (r.employee_id as UUID) ?? null,
      userId: (r.user_id as UUID) ?? null,
      signerName: r.signer_name as string,
      signedAt: (r.signed_at as Date).toISOString(),
      method: r.method as ContractSignature['method'],
      notes: (r.notes as string) ?? null,
    }));
  }

  /**
   * Hard-deletes a contract. Deliberately narrow: a signed employment
   * contract is a legal record (this is exactly what W7 exists to make
   * trustworthy), so nothing that carries a signature or has ever left
   * `draft` may be removed — `active`/`expired`/`terminated` are all facts
   * that happened and stay in the record, same reasoning as `terminate`
   * being a status change rather than a delete. A `draft` mistake with NO
   * signatures yet is the one case this ticket's "need CRUD" audit found
   * defensible to actually remove: nobody has acted on it, nothing points at
   * it as evidence of anything.
   */
  async remove(client: PoolClient, id: UUID): Promise<void> {
    const existing = await this.getById(client, id);
    if (existing.status !== 'draft') {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: `Contract ${existing.contractNumber} is ${existing.status} — only a draft with no signatures can be deleted`,
      });
    }
    if (existing.employeeSigned || existing.companySignerCount > 0) {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: `Contract ${existing.contractNumber} already has a recorded signature — it can no longer be deleted`,
      });
    }
    await withWrite(client, async () => {
      await client.query('DELETE FROM employment_contracts WHERE id = $1', [id]);
    });
  }

  /**
   * Marks lapsed contracts `expired` — an explicit, auditable sweep an HR admin
   * runs (or a scheduled job calls), never a trigger. Returns what it changed
   * so the caller can show it rather than reporting a silent number.
   */
  async sweepExpired(client: PoolClient): Promise<EmploymentContract[]> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: string }>(
        `UPDATE employment_contracts
            SET status = 'expired', updated_at = NOW()
          WHERE status = 'active'
            AND end_date IS NOT NULL
            AND end_date < (NOW() AT TIME ZONE 'Asia/Makassar')::date
          RETURNING id`,
      );
      const out: EmploymentContract[] = [];
      for (const row of res.rows) out.push(await this.getById(client, row.id as UUID));
      return out;
    });
  }

  /** PKWTT is permanent (no end date); every other type is fixed-term (must have one). */
  private assertTermMatchesType(type: string, endDate: string | null): void {
    if (type === 'pkwtt' && endDate) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A PKWTT (permanent) contract cannot have an end date',
      });
    }
    if (type !== 'pkwtt' && !endDate) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `A ${type} contract must have an end date`,
      });
    }
  }

  private async nextContractNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('KONTRAK', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('KONTRAK', period, res.rows[0]!.last_number);
  }

  private map(row: Record<string, unknown>): EmploymentContract {
    const endDate = row.end_date ? pgDateToIso(row.end_date as Date) : null;
    const status = row.status as EmploymentContract['status'];
    const employeeSigned = row.employee_signed === true;
    const companySignerCount = Number(row.company_signer_count ?? 0);
    return {
      id: row.id as UUID,
      contractNumber: row.contract_number as string,
      employeeId: row.employee_id as UUID,
      employeeName: row.employee_name as string,
      employeeNumber: row.employee_number as string,
      contractType: row.contract_type as EmploymentContract['contractType'],
      position: row.position as string,
      locationId: (row.location_id as UUID) ?? null,
      locationName: (row.location_name as string) ?? null,
      baseSalary: (row.base_salary as Money) ?? null,
      startDate: pgDateToIso(row.start_date as Date),
      endDate,
      status,
      signedAt: row.signed_at ? pgDateToIso(row.signed_at as Date) : null,
      documentAttachmentId: (row.document_attachment_id as UUID) ?? null,
      terminationReason: (row.termination_reason as string) ?? null,
      notes: (row.notes as string) ?? null,
      // Computed from the SERVER's date (`days_until_expiry` in the SELECT), so
      // a phone with a wrong clock cannot make a lapsed contract look current.
      daysUntilExpiry:
        status === 'active' && row.days_until_expiry !== null
          ? Number(row.days_until_expiry)
          : null,
      employeeSigned,
      companySignerCount,
      fullySigned: employeeSigned && companySignerCount > 0,
    };
  }
}

/**
 * One projection for every read, so the employee's own tab and HR's list can
 * never show different fields for the same contract. `days_until_expiry` is
 * computed in WITA (D-11), the timezone this whole system is pinned to.
 */
const SELECT_SQL = `
  SELECT c.*, e.name AS employee_name, e.employee_number, l.name AS location_name,
         CASE WHEN c.end_date IS NULL THEN NULL
              ELSE (c.end_date - (NOW() AT TIME ZONE 'Asia/Makassar')::date)
         END AS days_until_expiry,
         EXISTS (
           SELECT 1 FROM contract_signatures s
            WHERE s.contract_id = c.id AND s.party_type = 'employee'
         ) AS employee_signed,
         (
           SELECT COUNT(*) FROM contract_signatures s
            WHERE s.contract_id = c.id AND s.party_type = 'company'
         ) AS company_signer_count
    FROM employment_contracts c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN locations l ON l.id = c.location_id`;
