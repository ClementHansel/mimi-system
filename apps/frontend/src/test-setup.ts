import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia; components that read `prefers-reduced-motion` or
// similar (OfflineBanner, chart animations) would otherwise throw in tests.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
