import { MeOverview } from '@/components/me/MeOverview';

/**
 * F11 `me` — the EMPLOYEE INTERFACE (BUILD-PLAN W4-10, promoted to one of the
 * seven interfaces by the owner on 2026-08-21: "the interface that employee
 * will see to see their own personal data, loan req, leave req, absency,
 * contracts and everything about themself").
 *
 * The six surfaces — Absen, Slip Gaji, Cuti, Data Pribadi, Pinjaman, Kontrak
 * — used to be a two-row tab strip on this page. Owner, 2026-08-27: they
 * belong in the sidebar (behind the hamburger on a phone), so each is now its
 * own route under `/me/*` and each appears in the `employee` interface's
 * sidebar section in `lib/nav.ts`. That leaves `/me` itself free to be what
 * the same message asked for: personal analytics.
 *
 * MOBILE-FIRST throughout: a phone screen used one-handed in a car park at
 * 6am (NFR-04) — large touch targets, no dense tables, no hover-only
 * affordances. Strict self-scoping: every fetch under `/me` goes through
 * `.me`/`self`-suffixed endpoints (CONTRACTS §4.14/§4.15) — the backend
 * enforces it, but this surface never even offers a widget that could ask for
 * someone else's record.
 */
export default function MePage() {
  return <MeOverview />;
}
