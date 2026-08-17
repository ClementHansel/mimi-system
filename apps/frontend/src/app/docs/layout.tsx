import './docs.css';

/**
 * F-DOCS route group layout. Deliberately thin: the app already has one
 * shell (`AppShell` — sidebar, header, auth redirect) that wraps every
 * route including this one, so this layout does not duplicate auth
 * guarding or chrome. Its only job is to load the print stylesheet
 * (`docs.css`) scoped to `/docs/**` — Next's per-segment CSS chunking means
 * it's only on the page while a `/docs` route is mounted, so the print
 * rules below never leak onto other routes.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="docs-print-scope mx-auto flex w-full max-w-4xl flex-col">{children}</div>;
}
