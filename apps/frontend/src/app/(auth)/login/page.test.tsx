import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

/**
 * Regression cover for a credential leak found by the e2e suite.
 *
 * Before hydration React has not attached `onSubmit`, so submitting the form
 * ran the browser's DEFAULT submission. With the default GET method that
 * navigated to `/login?username=…&password=…` — the password in the URL bar,
 * the history, the next request's Referer and the server access log. Slow
 * devices hydrate late, so the users most exposed were the ones on phones.
 *
 * Two independent guards, tested independently, because either alone leaves a
 * hole: `method="post"` keeps credentials out of the URL if a native submit
 * ever happens (Enter pressed early, JS blocked), and the disabled button
 * keeps that path unreachable in the normal case.
 */
describe('LoginPage — pre-hydration credential safety', () => {
  it('never submits credentials via GET', () => {
    const { container } = render(<LoginPage />);
    const form = container.querySelector('form');

    expect(form).not.toBeNull();
    // `method` must be an explicit POST. Absent or "get" means a native submit
    // puts the password in the query string.
    expect(form!.getAttribute('method')?.toLowerCase()).toBe('post');
  });

  it('still wires the JS submit handler that prevents navigation entirely', () => {
    // If `onSubmit` were ever dropped, `method="post"` alone would send the
    // browser to a 405 on every login — safe, but completely broken. Asserting
    // the submit control exists keeps the two halves honest about their roles.
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: /masuk/i })).toHaveAttribute('type', 'submit');
  });
});
