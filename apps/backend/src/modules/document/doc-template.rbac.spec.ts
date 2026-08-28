/**
 * RBAC wiring test for the `document` module — copies
 * `modules/inventory/inventory.rbac.spec.ts`'s shape exactly (see that
 * file's own header for the full rationale): the REAL `PermissionsGuard` +
 * REAL (unmocked) `can()`/`RBAC_MATRIX`, driven by the REAL reflected
 * metadata off `DocTemplateController`'s and `DocumentController`'s actual
 * methods, for EVERY one of the 11 roles, both directions.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_MATRIX, RoleKey, type PermissionKey } from '@mimi/shared';

import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { DocTemplateController } from './doc-template.controller';
import { DocumentController } from './document.controller';

const guard = new PermissionsGuard(new Reflector());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => unknown;

function contextFor(handler: AnyHandler, ctrl: object, roleKey: RoleKey): ExecutionContext {
  const request = { user: { sub: 'test-user', roleKey } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => ctrl,
  } as unknown as ExecutionContext;
}

function requiredKeysOf(handler: AnyHandler): PermissionKey[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as PermissionKey[] | undefined;
}

function methodsOf(ctrl: { prototype: unknown }): Record<string, AnyHandler> {
  return ctrl.prototype as Record<string, AnyHandler>;
}

const ALL_ROLES = Object.values(RoleKey);

describe('document module — RBAC wiring against the real matrix', () => {
  describe('DocTemplateController', () => {
    it.each([
      ['getOne', 'doc_template.read'],
      ['putOne', 'doc_template.manage'],
      ['resetOne', 'doc_template.manage'],
    ] as const)('%s carries exactly @RequirePermission(%s)', (methodName, expectedKey) => {
      const handler = methodsOf(DocTemplateController)[methodName]!;
      expect(requiredKeysOf(handler)).toEqual([expectedKey]);
    });

    describe.each([
      ['getOne', 'doc_template.read'],
      ['putOne', 'doc_template.manage'],
      ['resetOne', 'doc_template.manage'],
    ] as const)('%s (@RequirePermission(%s)) — every role, both directions', (methodName, permissionKey) => {
      const handler = methodsOf(DocTemplateController)[methodName]!;

      it.each(ALL_ROLES)('role %s matches RBAC_MATRIX exactly', (roleKey) => {
        const expectedAllowed = RBAC_MATRIX[permissionKey][roleKey];
        const ctx = contextFor(handler, DocTemplateController, roleKey);

        if (expectedAllowed) {
          expect(guard.canActivate(ctx)).toBe(true);
        } else {
          expect(() => guard.canActivate(ctx)).toThrow();
        }
      });
    });

    it('sanity: doc_template.manage is refused for Kasir and allowed for Owner (CONTRACTS-style exact row)', () => {
      const handler = methodsOf(DocTemplateController).putOne!;
      expect(guard.canActivate(contextFor(handler, DocTemplateController, RoleKey.OWNER))).toBe(true);
      expect(() =>
        guard.canActivate(contextFor(handler, DocTemplateController, RoleKey.KASIR)),
      ).toThrow();
    });

    it('sanity: doc_template.read is UNIVERSAL — allowed for every role, including Kasir', () => {
      const handler = methodsOf(DocTemplateController).getOne!;
      for (const role of ALL_ROLES) {
        expect(guard.canActivate(contextFor(handler, DocTemplateController, role))).toBe(true);
      }
    });
  });

  describe('DocumentController', () => {
    it.each([
      ['getReceipt', 'pos.sale.read'],
      ['getInvoiceFromSale', 'pos.sale.read'],
      ['getInvoiceFromPurchaseOrder', 'purchasing.read'],
      ['postInvoiceManual', 'doc_template.manage'],
      ['getSuratJalan', 'delivery.read'],
      ['getVoucher', 'voucher.read'],
      ['getVoucherBatch', 'voucher.read'],
    ] as const)('%s carries exactly @RequirePermission(%s)', (methodName, expectedKey) => {
      const handler = methodsOf(DocumentController)[methodName]!;
      expect(requiredKeysOf(handler)).toEqual([expectedKey]);
    });

    describe.each([
      ['getReceipt', 'pos.sale.read'],
      ['getInvoiceFromSale', 'pos.sale.read'],
      ['getInvoiceFromPurchaseOrder', 'purchasing.read'],
      ['postInvoiceManual', 'doc_template.manage'],
      ['getSuratJalan', 'delivery.read'],
      ['getVoucher', 'voucher.read'],
      ['getVoucherBatch', 'voucher.read'],
    ] as const)('%s (@RequirePermission(%s)) — every role, both directions', (methodName, permissionKey) => {
      const handler = methodsOf(DocumentController)[methodName]!;

      it.each(ALL_ROLES)('role %s matches RBAC_MATRIX exactly', (roleKey) => {
        const expectedAllowed = RBAC_MATRIX[permissionKey][roleKey];
        const ctx = contextFor(handler, DocumentController, roleKey);

        if (expectedAllowed) {
          expect(guard.canActivate(ctx)).toBe(true);
        } else {
          expect(() => guard.canActivate(ctx)).toThrow();
        }
      });
    });
  });
});
