import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSessionStore } from '@/stores/session-store';
import { AppShell } from './AppShell';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

let mockPathname = '/dashboard';

/**
 * B-11 — "pre-hydration clicks are silently ignored app-wide".
 *
 * That was recorded as an open, app-wide gap: only the login form guarded it,
 * so the first click on any server-rendered control could do nothing, with no
 * feedback. Re-examined 2026-08-23, it is **no longer true**, and the reason is
 * structural rather than a fix anyone made for it: `AppShell` returns `null`
 * until `isHydrated`, so on every non-public route there is no control on
 * screen to click before hydration. `/login` is the only public route, and it
 * carries its own explicit `hydrated` guard plus a `method="post"` fallback.
 *
 * So this file does not fix anything. It PINS the property, because the gap
 * would come straight back from two ordinary-looking refactors: dropping the
 * `!isHydrated` early return (to remove a "flash of nothing"), or adding a
 * route with real controls to `PUBLIC_ROUTES`. Both would look harmless in
 * review and neither would fail any other test.
 */
describe('B-11 — nothing interactive renders before hydration', () => {
  beforeEach(() => {
    mockPathname = '/dashboard';
    useSessionStore.setState({ isHydrated: false, user: null });
  });

  it('renders NOTHING on an authenticated route until the session store has hydrated', () => {
    const { container } = render(
      <AppShell>
        <button type="button">Setujui</button>
      </AppShell>,
    );
    // Not "the button is disabled" — the button is not in the document at all,
    // which is the stronger property and the one that makes a lost click
    // impossible rather than merely unlikely.
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders nothing when hydrated but unauthenticated — the redirect is about to fire', () => {
    useSessionStore.setState({ isHydrated: true, user: null });
    render(
      <AppShell>
        <button type="button">Setujui</button>
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
  });

  it('the public-route escape hatch covers ONLY /login, which guards itself', () => {
    // The one path that bypasses the hydration gate above. If this list ever
    // grows to include a surface with real controls, B-11 is reopened and that
    // surface needs its own guard — the way the login form has one.
    mockPathname = '/login';
    render(
      <AppShell>
        <div>login form</div>
      </AppShell>,
    );
    expect(screen.getByText('login form')).toBeInTheDocument();

    // A near-miss must NOT be treated as public.
    mockPathname = '/loginsomething';
    useSessionStore.setState({ isHydrated: false, user: null });
    const { container } = render(
      <AppShell>
        <div>not the login page</div>
      </AppShell>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
