import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ApproveReplenishmentDto } from './dto/approve-replenishment.dto';
import { CreateReplenishmentDto } from './dto/create-replenishment.dto';
import { RejectReplenishmentDto } from './dto/reject-replenishment.dto';
import { UpdateReplenishmentDto } from './dto/update-replenishment.dto';

const VALID_UUID = crypto.randomUUID();

describe('CreateReplenishmentDto', () => {
  it('accepts a well-formed request with one line', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, {
      locationId: VALID_UUID,
      lines: [{ itemId: VALID_UUID, qtyRequested: '12.500', unitId: VALID_UUID }],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing locationId', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, {
      lines: [{ itemId: VALID_UUID, qtyRequested: '1.000', unitId: VALID_UUID }],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an empty lines array', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, { locationId: VALID_UUID, lines: [] });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects more than 3 decimal places on qtyRequested (NUMERIC(14,3), CONTRACTS.md §0)', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, {
      locationId: VALID_UUID,
      lines: [{ itemId: VALID_UUID, qtyRequested: '12.3456', unitId: VALID_UUID }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric qtyRequested', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, {
      locationId: VALID_UUID,
      lines: [{ itemId: VALID_UUID, qtyRequested: 'abc', unitId: VALID_UUID }],
    });
    expect((await validate(dto, { whitelist: true })).length).toBeGreaterThan(0);
  });

  it('rejects an invalid source value', async () => {
    const dto = plainToInstance(CreateReplenishmentDto, {
      locationId: VALID_UUID,
      source: 'wishful_thinking',
      lines: [{ itemId: VALID_UUID, qtyRequested: '1.000', unitId: VALID_UUID }],
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});

describe('UpdateReplenishmentDto', () => {
  it('accepts an empty body (nothing to change)', async () => {
    const dto = plainToInstance(UpdateReplenishmentDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty lines array when lines IS supplied', async () => {
    const dto = plainToInstance(UpdateReplenishmentDto, { lines: [] });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('RejectReplenishmentDto — reason mandatory (FR-LOG-13)', () => {
  it('rejects an empty reason', async () => {
    expect(
      await validate(plainToInstance(RejectReplenishmentDto, { reason: '' })),
    ).not.toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    expect(await validate(plainToInstance(RejectReplenishmentDto, {}))).not.toHaveLength(0);
  });

  it('accepts a non-empty reason', async () => {
    expect(
      await validate(
        plainToInstance(RejectReplenishmentDto, { reason: 'Stok outlet masih cukup' }),
      ),
    ).toHaveLength(0);
  });
});

describe('ApproveReplenishmentDto / ReplenishmentAmendmentDto — per-line reason mandatory when amending (FR-LOG-13)', () => {
  it('accepts a plain approve with no amendments', async () => {
    expect(await validate(plainToInstance(ApproveReplenishmentDto, {}))).toHaveLength(0);
  });

  it('accepts a valid amendment', async () => {
    const dto = plainToInstance(ApproveReplenishmentDto, {
      amendments: [{ lineId: VALID_UUID, qtyApproved: '12.000', reason: 'Stok gudang terbatas' }],
    });
    expect(await validate(dto, { whitelist: true })).toHaveLength(0);
  });

  it('rejects an amendment with an empty per-line reason', async () => {
    const dto = plainToInstance(ApproveReplenishmentDto, {
      amendments: [{ lineId: VALID_UUID, qtyApproved: '12.000', reason: '' }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an amendment with a missing per-line reason', async () => {
    const dto = plainToInstance(ApproveReplenishmentDto, {
      amendments: [{ lineId: VALID_UUID, qtyApproved: '12.000' }],
    });
    expect((await validate(dto, { whitelist: true })).length).toBeGreaterThan(0);
  });

  it('rejects a negative qtyApproved shape (regex gate — negative numbers are not a valid Qty string at all)', async () => {
    const dto = plainToInstance(ApproveReplenishmentDto, {
      amendments: [{ lineId: VALID_UUID, qtyApproved: '-1.000', reason: 'x' }],
    });
    expect((await validate(dto, { whitelist: true })).length).toBeGreaterThan(0);
  });
});
