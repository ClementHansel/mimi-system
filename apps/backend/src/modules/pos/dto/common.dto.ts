import { Matches } from 'class-validator';
import { applyDecorators } from '@nestjs/common';

/**
 * Wire-format guards for the two decimal-string types CONTRACTS.md §0 binds
 * every agent to: `Money` (NUMERIC(18,2), e.g. `"125000.00"`) and `Qty`
 * (NUMERIC(14,3), e.g. `"1.000"`). Never a JS number (D-10) — these
 * decorators exist so a malformed decimal string (wrong scale, a stray
 * float-ism like `"12000"` with no cents) fails validation at the API
 * boundary with `ERR_VALIDATION`, rather than reaching `@mimi/shared`'s
 * `parseFixed` and throwing a less legible `RangeError` deep inside a
 * service method.
 */
const MONEY_RE = /^-?\d+\.\d{2}$/;
const QTY_RE = /^-?\d+\.\d{3}$/;

export const IsMoneyString = (): PropertyDecorator =>
  applyDecorators(Matches(MONEY_RE, { message: 'must be a decimal money string with exactly 2 fractional digits, e.g. "125000.00"' }));

export const IsQtyString = (): PropertyDecorator =>
  applyDecorators(Matches(QTY_RE, { message: 'must be a decimal quantity string with exactly 3 fractional digits, e.g. "1.000"' }));
