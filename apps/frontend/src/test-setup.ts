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

// jsdom implements no layout, so `scrollIntoView` does not exist on elements.
// Any component that scrolls a list to its newest item — the chat thread, and
// anything similar later — throws without this. Same category as `matchMedia`
// above: a jsdom gap, not something the component should defend against.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
