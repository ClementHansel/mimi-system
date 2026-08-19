import './print.css';

/**
 * W5-05 route group for printable documents (Surat Jalan, slip gaji).
 *
 * Deliberately thin, like `app/docs/layout.tsx`: `AppShell` already wraps
 * every route and still enforces the auth redirect here, so this layout does
 * not duplicate guarding. Its only jobs are loading the print stylesheet
 * scoped to `/print/**` and giving the documents a white page to sit on.
 *
 * `/print` is registered in `AppShell`'s `CHROMELESS_PREFIX_ROUTES`, so there
 * is no sidebar or header in the tree to hide at print time.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-stone-100 text-black">{children}</div>;
}
