import type { PermissionKeyOrKeys } from '@/lib/permissions';
import { ApprovalDocumentType } from '@/lib/shared-types';

/**
 * Per-document-type wiring for the deep-link detail screen
 * (`/approvals/:documentType/:documentId`). CONTRACTS §4.0: "Approve/reject/
 * amend actions are exposed per document type on the owning module... so
 * permissions and side effects stay module-local" — this table is the map
 * from the 12 `ApprovalDocumentType` values to that module's base path +
 * the CONTRACTS §3 permission key(s) gating each action, transcribed
 * verbatim from the endpoint rows (§4.7–§4.16).
 *
 * `approveSupported: false` marks the two document types whose real
 * "decide" action isn't a plain `{note?}`/`{reason}` POST this generic panel
 * can drive honestly:
 * - `void_refund` approve requires a PIN re-entry (`{pin}` — APR-02, D-17),
 *   a distinct verified-identity flow (`/auth/pin/verify`) this screen does
 *   not own and should not half-reimplement.
 * - `payment_verification`'s Owner approval step is folded into
 *   `POST /api/accounting/payments/:id/pay` (§5.8) — there is no standalone
 *   "approve" endpoint; the decision happens in the Finance/payment module.
 * Both still expose `rejectPermission` (a plain `{reason}` POST) and both are
 * always readable via `ApprovalTimeline` — a document a caller cannot act on
 * from here is still shown, per the brief's "render that state honestly
 * rather than hiding the document."
 */
export interface DocumentTypeConfig {
  documentType: ApprovalDocumentType;
  /** Owning module's REST base, e.g. `/replenishment/:id/approve`. */
  basePath: string;
  labelKey: string;
  approveSupported: boolean;
  /** Only set when `approveSupported` — the i18n key explaining why not, otherwise. */
  approveUnsupportedKey?: string;
  approvePermission?: PermissionKeyOrKeys;
  rejectPermission?: PermissionKeyOrKeys;
  /** cash_variance_proposal (Amendment 2, §5.9): reason is required on BOTH approve and reject. */
  reasonRequiredOnApprove?: boolean;
  /** replenishment_request only — approve accepts a per-line `amendments[]` (FR-LOG-13). */
  supportsAmend?: boolean;
}

export const DOCUMENT_TYPE_CONFIG: Record<ApprovalDocumentType, DocumentTypeConfig> = {
  [ApprovalDocumentType.REPLENISHMENT_REQUEST]: {
    documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
    basePath: '/replenishment',
    labelKey: 'approvals.documentType.replenishment_request',
    approveSupported: true,
    approvePermission: ['replenishment.approve.supervisor', 'replenishment.approve.warehouse'],
    rejectPermission: ['replenishment.approve.supervisor', 'replenishment.approve.warehouse'],
    supportsAmend: true,
  },
  [ApprovalDocumentType.VOID_REFUND]: {
    documentType: ApprovalDocumentType.VOID_REFUND,
    basePath: '/pos/void-refunds',
    labelKey: 'approvals.documentType.void_refund',
    approveSupported: false,
    approveUnsupportedKey: 'approvalDetail.approveUnsupported.voidRefund',
    rejectPermission: 'pos.void.approve',
  },
  [ApprovalDocumentType.PURCHASE_REQUEST]: {
    documentType: ApprovalDocumentType.PURCHASE_REQUEST,
    basePath: '/purchasing/requests',
    labelKey: 'approvals.documentType.purchase_request',
    approveSupported: true,
    approvePermission: 'purchasing.pr.approve',
    rejectPermission: 'purchasing.pr.approve',
  },
  [ApprovalDocumentType.PURCHASE_ORDER]: {
    documentType: ApprovalDocumentType.PURCHASE_ORDER,
    basePath: '/purchasing/orders',
    labelKey: 'approvals.documentType.purchase_order',
    approveSupported: true,
    approvePermission: 'purchasing.po.approve',
    rejectPermission: 'purchasing.po.approve',
  },
  [ApprovalDocumentType.STOCK_OPNAME]: {
    documentType: ApprovalDocumentType.STOCK_OPNAME,
    basePath: '/stock-opname',
    labelKey: 'approvals.documentType.stock_opname',
    approveSupported: true,
    approvePermission: 'opname.approve',
    rejectPermission: 'opname.approve',
  },
  [ApprovalDocumentType.RETURN]: {
    documentType: ApprovalDocumentType.RETURN,
    basePath: '/returns',
    labelKey: 'approvals.documentType.return',
    approveSupported: true,
    approvePermission: 'return.approve',
    rejectPermission: 'return.approve',
  },
  [ApprovalDocumentType.PAYROLL_RUN]: {
    documentType: ApprovalDocumentType.PAYROLL_RUN,
    basePath: '/payroll/runs',
    labelKey: 'approvals.documentType.payroll_run',
    approveSupported: true,
    approvePermission: 'payroll.run.approve',
    rejectPermission: 'payroll.run.approve',
  },
  [ApprovalDocumentType.PAYMENT_VERIFICATION]: {
    documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
    basePath: '/accounting/payments',
    labelKey: 'approvals.documentType.payment_verification',
    approveSupported: false,
    approveUnsupportedKey: 'approvalDetail.approveUnsupported.paymentVerification',
    rejectPermission: 'payment.reject',
  },
  [ApprovalDocumentType.LEAVE_REQUEST]: {
    documentType: ApprovalDocumentType.LEAVE_REQUEST,
    basePath: '/hr/leaves',
    labelKey: 'approvals.documentType.leave_request',
    approveSupported: true,
    approvePermission: 'hr.leave.approve',
    rejectPermission: 'hr.leave.approve',
  },
  [ApprovalDocumentType.EMPLOYEE_LOAN]: {
    documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
    basePath: '/payroll/loans',
    labelKey: 'approvals.documentType.employee_loan',
    approveSupported: true,
    approvePermission: 'payroll.loan.approve',
    rejectPermission: 'payroll.loan.approve',
  },
  [ApprovalDocumentType.CASH_VARIANCE_PROPOSAL]: {
    documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
    basePath: '/pos/cash-variances',
    labelKey: 'approvals.documentType.cash_variance_proposal',
    approveSupported: true,
    approvePermission: 'pos.cash_variance.approve',
    rejectPermission: 'pos.cash_variance.approve',
    reasonRequiredOnApprove: true,
  },
  [ApprovalDocumentType.WASTE]: {
    documentType: ApprovalDocumentType.WASTE,
    basePath: '/waste',
    labelKey: 'approvals.documentType.waste',
    approveSupported: true,
    approvePermission: 'waste.approve',
    rejectPermission: 'waste.approve',
  },
};

export function documentTypeConfig(documentType: string): DocumentTypeConfig | null {
  return (DOCUMENT_TYPE_CONFIG as Record<string, DocumentTypeConfig>)[documentType] ?? null;
}
