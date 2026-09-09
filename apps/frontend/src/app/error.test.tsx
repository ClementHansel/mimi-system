import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AppError from './error';
import HomePage from './page';
import { useSessionStore } from '@/stores/session-store';
import { logout } from '@/lib/auth';

/**
 * A CLIENT-SIDE EXCEPTION MUST NOT BE A DEAD END.
 *
 * MA-190: a newly added employee logged in, set their PIN, and landed on
 *
 *   "Application error: a client-side exception has occurred while loading
 *    mimichicken.my.id (see the browser console for more information)."
 *
 * That is Next's LAST-RESORT fallback, shown when a client render throws and
 * no `error.tsx` exists to catch it — and none existed anywhere in this app.
 * So every client-side exception in every interface produced that: an English
 * developer sentence on a white page, no retry, no sign-out, nothing to report
 * but a screenshot. The specific throw is not identifiable from a screenshot
 * with no console and does not reproduce on the current build; the dead end is
 * fixable regardless, and is the part that turned one crash into an
 * unrecoverable session.
 *
 * The second half is the asymmetry `session-store.ts` describes in its own
 * comments and then only half-guarded: hydration validated the stored `Me`,
 * `setSession` stored whatever login returned. A `Me` missing `permissions` or
 * `locations` "throws during render and Next replaces the page with its
 * client-side-exception screen" — unreachable by RELOADING into a bad session,
 * reachable by LOGGING IN to one, which is exactly the reported sequence.
 */
vi.mock('@/lib/auth', () => ({ logout: vi.fn() }));
// `HomePage` calls `useRouter()`; jsdom has no app-router context. Same mock
// `app/page.test.tsx` next door uses.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

function boom(digest?: string): Error & { digest?: string } {
  const err = new Error('kaboom') as Error & { digest?: string };
  if (digest) err.digest = digest;
  return err;
}

describe('app/error.tsx — the recovery screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('says what happened in Indonesian, not Next’s English fallback', () => {
    render(<AppError error={boom()} reset={() => {}} />);

    expect(screen.getByText(/Halaman ini gagal dimuat/)).toBeInTheDocument();
    // The reassurance matters as much as the error: an outlet crew member
    // mid-shift needs to know the till did not lose their work.
    expect(screen.getByText(/Data Anda tidak terpengaruh/)).toBeInTheDocument();
    expect(screen.queryByText(/Application error/i)).not.toBeInTheDocument();
  });

  it('retries the segment', () => {
    const reset = vi.fn();
    render(<AppError error={boom()} reset={reset} />);

    fireEvent.click(screen.getByRole('button', { name: /Coba Lagi/i }));
    expect(reset).toHaveBeenCalled();
  });

  it('offers sign-out, which is the actual escape from a bad session', () => {
    render(<AppError error={boom()} reset={() => {}} />);

    // A crash caused by an unusable stored session cannot be retried out of.
    // Before this screen existed, the only way out was knowing to clear
    // browser storage by hand.
    fireEvent.click(screen.getByRole('button', { name: /Keluar/i }));
    expect(logout).toHaveBeenCalled();
  });

  it('shows the digest, so the next report is diagnosable', () => {
    render(<AppError error={boom('a1b2c3d4')} reset={() => {}} />);

    // The one thing that makes a repeat report actionable instead of another
    // screenshot of a white page.
    expect(screen.getByText(/a1b2c3d4/)).toBeInTheDocument();
  });

  it('omits the reference line when there is no digest', () => {
    render(<AppError error={boom()} reset={() => {}} />);
    expect(screen.queryByText(/Kode kesalahan/)).not.toBeInTheDocument();
  });
});

describe('session-store — a login cannot store a Me that crashes the render', () => {
  afterEach(() => useSessionStore.setState({ accessToken: null, refreshToken: null, user: null }));

  it('coerces missing permissions/locations rather than letting them reach the tree', () => {
    // Exactly the shape `session-store.ts` says throws during render.
    useSessionStore.getState().setSession({
      accessToken: 'tok',
      refreshToken: 'ref',
      user: {
        id: 'u1',
        username: 'baru01',
        name: 'Karyawan Baru',
        roleKey: 'kasir',
      } as never,
    });

    const user = useSessionStore.getState().user!;
    expect(user.permissions).toEqual([]);
    expect(user.locations).toEqual([]);
  });

  it('keeps the object identity when nothing needed coercing', () => {
    // Returning a fresh object every time would make every store subscriber
    // re-render on any unrelated set.
    const user = {
      id: 'u1',
      username: 'owner1',
      name: 'Owner',
      roleKey: 'owner',
      permissions: ['location.read'],
      locations: [],
    } as never;

    useSessionStore.getState().setSession({ accessToken: 't', refreshToken: 'r', user });
    expect(useSessionStore.getState().user).toBe(user);
  });

  it('lets the hub render for that user instead of throwing', () => {
    // The end-to-end point of the coercion: `app/page.tsx` reads
    // `user.locations.length` and `usePermissions` reads `user.permissions`.
    useSessionStore.setState({
      user: {
        id: 'u1',
        username: 'baru01',
        name: 'Karyawan Baru',
        roleKey: 'kasir',
      } as never,
      isHydrated: true,
    });
    // Prove the raw shape really is the dangerous one before coercion…
    expect(useSessionStore.getState().user!.permissions).toBeUndefined();

    useSessionStore.getState().updateUser({ mustSetPin: false });

    // …and that going through the store's own update path makes it renderable.
    expect(() => render(<HomePage />)).not.toThrow();
  });
});
