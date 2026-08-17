import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Wire-format check for a `Qty` decimal string (D-10, CONTRACTS.md §0):
 * non-negative, up to 3 decimal places, no exponent/leading-plus/thousands
 * separators — e.g. `"12.5"`, `"0.250"`, `"10"`. Structural only; the
 * service layer still runs the value through `@mimi/shared`'s `parseQty` /
 * `compareQty` for canonical arithmetic and a `> 0` business check where the
 * schema demands it (`qty_requested`, `sj_lines.qty`). Kept local to this
 * module rather than a shared decorator because no other Wave 3 module has
 * asked for one yet — promote to `packages/shared` if a second module needs
 * the identical check (its owner would do that, not this agent).
 */
const QTY_STRING_RE = /^\d+(\.\d{1,3})?$/;

export function IsQtyString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isQtyString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && QTY_STRING_RE.test(value);
        },
        defaultMessage(): string {
          return `${propertyName} must be a non-negative decimal string with up to 3 decimal places (e.g. "12.500")`;
        },
      },
    });
  };
}
