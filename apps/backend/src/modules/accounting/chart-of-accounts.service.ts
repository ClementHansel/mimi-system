import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_CONFLICT, ERR_NOT_FOUND, ERR_VALIDATION, type Account } from '@mimi/shared';
import type { CreateAccountDto, ListAccountsQueryDto, UpdateAccountDto } from './dto/accounting.dto';
import type { AccountRow } from './accounting.types';
import { withWrite } from './db-tx';

const ACCOUNT_SELECT = `SELECT id, code, name, type, normal_balance, parent_id, is_postable, is_system, is_active FROM chart_of_accounts`;

/**
 * M17 chart of accounts (CONTRACTS.md §4.17, §6.1). Raw `pg` on the
 * caller-supplied `PoolClient` — RLS (migration 095: `ROLE(owner,manager,
 * finance)` read, `ROLE(owner,finance)` write) is already live on that
 * client.
 */
@Injectable()
export class ChartOfAccountsService {
  async list(client: PoolClient, query: ListAccountsQueryDto): Promise<Account[]> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.type) { conds.push(`type = $${i++}`); args.push(query.type); }
    if (query.active !== undefined) { conds.push(`is_active = $${i++}`); args.push(query.active); }
    if (query.q) { conds.push(`(code ILIKE $${i} OR name ILIKE $${i})`); args.push(`%${query.q}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const res = await client.query<AccountRow>(`${ACCOUNT_SELECT} ${where} ORDER BY code`, args);
    return res.rows.map(toAccount);
  }

  async get(client: PoolClient, id: string): Promise<Account> {
    const res = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Account ${id} not found` });
    return toAccount(row);
  }

  async findByCode(client: PoolClient, code: string): Promise<AccountRow | undefined> {
    const res = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE code = $1`, [code]);
    return res.rows[0];
  }

  async requireByCode(client: PoolClient, code: string): Promise<AccountRow> {
    const row = await this.findByCode(client, code);
    if (!row) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Account code '${code}' not found in chart_of_accounts — posting rule or manual entry references a code that was never seeded` });
    }
    return row;
  }

  async create(client: PoolClient, dto: CreateAccountDto): Promise<Account> {
    const existing = await this.findByCode(client, dto.code);
    if (existing) throw new ConflictException({ code: ERR_CONFLICT, message: `Account code '${dto.code}' already exists` });

    if (dto.parentId) {
      const parent = await client.query<{ id: string }>(`SELECT id FROM chart_of_accounts WHERE id = $1`, [dto.parentId]);
      if (!parent.rows[0]) throw new BadRequestException({ code: ERR_VALIDATION, message: `parentId ${dto.parentId} not found` });
    }

    return withWrite(client, async () => {
      const res = await client.query<AccountRow>(
        `INSERT INTO chart_of_accounts (code, name, type, normal_balance, parent_id, is_postable, is_system, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,false,true)
         RETURNING id, code, name, type, normal_balance, parent_id, is_postable, is_system, is_active`,
        [dto.code, dto.name, dto.type, dto.normalBalance, dto.parentId ?? null, dto.isPostable ?? true],
      );
      return toAccount(res.rows[0]!);
    });
  }

  async update(client: PoolClient, id: string, dto: UpdateAccountDto): Promise<Account> {
    const current = await this.get(client, id);

    if (dto.isActive === false && current.isSystem) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Account ${current.code} is a system account (is_system=true, referenced by posting_rules) — it cannot be deactivated`,
      });
    }

    return withWrite(client, async () => {
      const res = await client.query<AccountRow>(
        `UPDATE chart_of_accounts SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = NOW()
         WHERE id = $1
         RETURNING id, code, name, type, normal_balance, parent_id, is_postable, is_system, is_active`,
        [id, dto.name ?? null, dto.isActive ?? null],
      );
      return toAccount(res.rows[0]!);
    });
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    parentId: row.parent_id,
    isPostable: row.is_postable,
    isSystem: row.is_system,
    isActive: row.is_active,
  };
}
