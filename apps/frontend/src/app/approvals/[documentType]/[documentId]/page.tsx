import { ApprovalDetailView } from '@/components/approvals/ApprovalDetailView';

/**
 * `/approvals/:documentType/:documentId` — the approval-notification deep
 * link (CONTRACTS §4.0 `ApprovalService.deepLinkFor`). Every other route in
 * this app is a static `'use client'` page; this is the first dynamic
 * segment, so it stays a plain (server) params-unwrapping shell per Next.js
 * 15's async `params` — all data fetching and interactivity live in the
 * client `ApprovalDetailView` it renders.
 */
export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ documentType: string; documentId: string }>;
}) {
  const { documentType, documentId } = await params;
  return <ApprovalDetailView documentType={documentType} documentId={documentId} />;
}
