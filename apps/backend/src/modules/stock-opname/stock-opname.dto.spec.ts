import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateOpnameDto } from './dto/create-opname.dto';
import { RejectOpnameDto } from './dto/reject-opname.dto';
import { UpsertOpnameLinesDto } from './dto/upsert-lines.dto';

const VALID_UUID = crypto.randomUUID();

describe('CreateOpnameDto', () => {
  it('accepts a bare locationId', async () => {
    const dto = plainToInstance(CreateOpnameDto, { locationId: VALID_UUID });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing locationId', async () => {
    const dto = plainToInstance(CreateOpnameDto, {});
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('UpsertOpnameLinesDto — Qty decimal-string gate', () => {
  it('accepts up-to-3-decimal quantities, positive or negative', async () => {
    const dto = plainToInstance(UpsertOpnameLinesDto, {
      lines: [
        { storageAreaId: VALID_UUID, itemId: VALID_UUID, countedQty: '12.345' },
        { storageAreaId: VALID_UUID, itemId: VALID_UUID, countedQty: '0' },
      ],
    });
    expect(await validate(dto, { whitelist: true })).toHaveLength(0);
  });

  it('rejects more than 3 decimal places (NUMERIC(14,3), CONTRACTS.md §0)', async () => {
    const dto = plainToInstance(UpsertOpnameLinesDto, {
      lines: [{ storageAreaId: VALID_UUID, itemId: VALID_UUID, countedQty: '12.3456' }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric countedQty', async () => {
    const dto = plainToInstance(UpsertOpnameLinesDto, {
      lines: [{ storageAreaId: VALID_UUID, itemId: VALID_UUID, countedQty: 'abc' }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty lines array', async () => {
    const dto = plainToInstance(UpsertOpnameLinesDto, { lines: [] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('RejectOpnameDto — reason mandatory (CONTRACTS.md §4.8)', () => {
  it('rejects an empty reason', async () => {
    const dto = plainToInstance(RejectOpnameDto, { reason: '' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts a non-empty reason', async () => {
    const dto = plainToInstance(RejectOpnameDto, { reason: 'Data tidak valid' });
    expect(await validate(dto)).toHaveLength(0);
  });
});
