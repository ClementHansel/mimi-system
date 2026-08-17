import { ApprovalDocumentType, LocationType, ReturnDirection, RoleKey } from '@mimi/shared';
import type { DbClient, DocumentContext } from './types';

/**
 * Solves BUILD-PLAN §5 carried-forward item 2 (also documented at
 * `database/migrations/069_indexes_rls_060.sql`'s header): four chains
 * cannot be expressed by `approval_chain_steps`' `(document_type, step_no)
 * -> one role` shape.
 *
 *  - `stock_opname` / `waste` step 1: the eligible role depends on the
 *    document's LOCATION TYPE (an outlet's opname/waste goes to its
 *    Supervisor; a warehouse's goes to its Kepala Gudang).
 *  - `return` step 1: the eligible role depends on DIRECTION
 *    (`outlet_to_warehouse` -> Supervisor; `warehouse_to_supplier` ->
 *    Kepala Gudang) — CONTRACTS.md §5.5 vs §5.6 are genuinely different
 *    chains sharing one `document_type`.
 *  - `leave_request` step 1: satisfied by ANY of Supervisor, HR Admin, or
 *    Manager — not a location/direction branch at all, just a broader
 *    static set than the single seeded role.
 *
 * Design choice (documented in the kernel report): extend the seeded data
 * shape would mean adding a `variant` column to `approval_chain_steps` and
 * reseeding — a schema change, which this agent does not improvise (BUILD-
 * PLAN's "Schema changes go through senior-db / architect-approved
 * migration" rule). Until that `2xx` migration lands, this resolver is the
 * runtime substitute the seed migration's own header comment anticipated:
 * a small, DATA-SHAPED override table (`ROLE_OVERRIDES` below) keyed by
 * `(documentType, stepNo)`, not a spray of `if (documentType === ...)`
 * branches through the service. Every other document type's steps pass
 * through unchanged (`[storedRole]`).
 *
 * `resolveDocumentContext` does the one piece of I/O this needs — reading
 * the document's OWN table (`stock_opname`/`waste_records`/`returns`) for
 * its location type or direction — via the caller-supplied `DbClient`, same
 * as `ScopeService` reads across module boundaries for RLS scope (that is
 * established precedent in this codebase, not a new pattern).
 */

type RoleOverride = (storedRole: RoleKey, ctx: DocumentContext) => readonly RoleKey[];

function byLocationTypeVariant(storedRole: RoleKey, ctx: DocumentContext): readonly RoleKey[] {
  if (ctx.variant === 'warehouse') return [RoleKey.KEPALA_GUDANG];
  if (ctx.variant === 'outlet') return [RoleKey.SUPERVISOR];
  return [storedRole]; // context unresolved (e.g. amend on a not-yet-persisted doc) — fall back to the seeded default
}

function byReturnDirection(storedRole: RoleKey, ctx: DocumentContext): readonly RoleKey[] {
  if (ctx.variant === ReturnDirection.WAREHOUSE_TO_SUPPLIER) return [RoleKey.KEPALA_GUDANG];
  if (ctx.variant === ReturnDirection.OUTLET_TO_WAREHOUSE) return [RoleKey.SUPERVISOR];
  return [storedRole];
}

function anyOfLeaveApprovers(): readonly RoleKey[] {
  return [RoleKey.SUPERVISOR, RoleKey.HR_ADMIN];
}

const ROLE_OVERRIDES: Partial<Record<ApprovalDocumentType, Partial<Record<number, RoleOverride>>>> = {
  [ApprovalDocumentType.STOCK_OPNAME]: { 1: byLocationTypeVariant },
  [ApprovalDocumentType.WASTE]: { 1: byLocationTypeVariant },
  [ApprovalDocumentType.RETURN]: { 1: byReturnDirection },
  [ApprovalDocumentType.LEAVE_REQUEST]: { 1: anyOfLeaveApprovers },
};

/** Every distinct role ever named by an override — used by property tests to assert nothing else changed. */
export const IRREGULAR_CHAIN_DOCUMENT_TYPES: readonly ApprovalDocumentType[] = Object.keys(
  ROLE_OVERRIDES,
) as ApprovalDocumentType[];

/**
 * Given the chain-seeded role for a step and the document's resolved
 * context, returns the actual eligible role SET. For the 12-3=9 regular
 * document types (and for step 2+ of the irregular ones, e.g. opname's
 * manager-threshold step) this is a pure passthrough — no branching.
 */
export function resolveEligibleRoles(
  documentType: ApprovalDocumentType,
  stepNo: number,
  storedRole: RoleKey,
  ctx: DocumentContext,
): readonly RoleKey[] {
  const override = ROLE_OVERRIDES[documentType]?.[stepNo];
  return override ? override(storedRole, ctx) : [storedRole];
}

/**
 * Reads the one piece of context the four irregular chains need, straight
 * from the document's own table. Every other document type resolves to `{}`
 * (no context needed — `resolveEligibleRoles` will no-op for them).
 */
export async function resolveDocumentContext(
  client: DbClient,
  documentType: ApprovalDocumentType,
  documentId: string,
): Promise<DocumentContext> {
  switch (documentType) {
    case ApprovalDocumentType.STOCK_OPNAME: {
      const res = await client.query<{ location_type: string }>(
        `SELECT l.type AS location_type
           FROM stock_opname so
           JOIN locations l ON l.id = so.location_id
          WHERE so.id = $1`,
        [documentId],
      );
      return { variant: locationTypeToVariant(res.rows[0]?.location_type) };
    }
    case ApprovalDocumentType.WASTE: {
      const res = await client.query<{ location_type: string }>(
        `SELECT l.type AS location_type
           FROM waste_records w
           JOIN locations l ON l.id = w.location_id
          WHERE w.id = $1`,
        [documentId],
      );
      return { variant: locationTypeToVariant(res.rows[0]?.location_type) };
    }
    case ApprovalDocumentType.RETURN: {
      const res = await client.query<{ direction: string }>(
        `SELECT direction FROM returns WHERE id = $1`,
        [documentId],
      );
      const direction = res.rows[0]?.direction;
      return {
        variant:
          direction === ReturnDirection.OUTLET_TO_WAREHOUSE || direction === ReturnDirection.WAREHOUSE_TO_SUPPLIER
            ? direction
            : undefined,
      };
    }
    default:
      return {};
  }
}

function locationTypeToVariant(locationType: string | undefined): 'outlet' | 'warehouse' | undefined {
  if (locationType === LocationType.WAREHOUSE) return 'warehouse';
  if (locationType === LocationType.OUTLET) return 'outlet';
  return undefined;
}

/**
 * Batched sibling of `resolveDocumentContext` — one query per irregular
 * document type covering every id on a page, instead of N+1 per-row
 * lookups. Used by the "my pending approvals" query, which otherwise would
 * issue one extra round-trip per pending row.
 */
export async function resolveDocumentContextsBatch(
  client: DbClient,
  documentType: ApprovalDocumentType,
  documentIds: readonly string[],
): Promise<Map<string, DocumentContext>> {
  const result = new Map<string, DocumentContext>();
  if (documentIds.length === 0) return result;

  switch (documentType) {
    case ApprovalDocumentType.STOCK_OPNAME: {
      const res = await client.query<{ id: string; location_type: string }>(
        `SELECT so.id, l.type AS location_type
           FROM stock_opname so
           JOIN locations l ON l.id = so.location_id
          WHERE so.id = ANY($1::uuid[])`,
        [documentIds],
      );
      for (const row of res.rows) result.set(row.id, { variant: locationTypeToVariant(row.location_type) });
      return result;
    }
    case ApprovalDocumentType.WASTE: {
      const res = await client.query<{ id: string; location_type: string }>(
        `SELECT w.id, l.type AS location_type
           FROM waste_records w
           JOIN locations l ON l.id = w.location_id
          WHERE w.id = ANY($1::uuid[])`,
        [documentIds],
      );
      for (const row of res.rows) result.set(row.id, { variant: locationTypeToVariant(row.location_type) });
      return result;
    }
    case ApprovalDocumentType.RETURN: {
      const res = await client.query<{ id: string; direction: string }>(
        `SELECT id, direction FROM returns WHERE id = ANY($1::uuid[])`,
        [documentIds],
      );
      for (const row of res.rows) {
        const direction = row.direction;
        result.set(row.id, {
          variant:
            direction === ReturnDirection.OUTLET_TO_WAREHOUSE || direction === ReturnDirection.WAREHOUSE_TO_SUPPLIER
              ? direction
              : undefined,
        });
      }
      return result;
    }
    default:
      for (const id of documentIds) result.set(id, {});
      return result;
  }
}
