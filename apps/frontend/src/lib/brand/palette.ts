import type { BrandIdentity, BrandPalette } from '@/lib/shared-types';

/**
 * Turning the owner's FOUR brand colours into the NINE-step ramp the app's UI
 * is painted with — and the reason those two numbers are different.
 *
 * `packages/shared/src/brand.ts` explains why the brand identity carries four
 * colours: a document needs exactly a brand colour, an accent, an ink and a
 * muted. The app's own UI needs more than that. `globals.css` declares
 * `--color-brand-50 … --color-brand-900` because interactive states are made
 * of a ramp: `bg-brand-50` for a selected row, `bg-brand-500` for a primary
 * button, `bg-brand-600` for its hover, `text-brand-700` on a tinted chip,
 * `--color-ring` for focus. Paper has none of those states. So the mapping
 * from four to nine is a FRONTEND concern and it lives here.
 *
 * ── THE INTERPOLATION, AND WHY THIS ONE ──────────────────────────────────────
 * The ramp is derived from `primaryColor` alone by transplanting the SHIPPED
 * terracotta ramp's own shape onto the owner's hue:
 *
 *   hue        ← the owner's hue, shifted by each reference step's hue OFFSET
 *                from reference step 600;
 *   saturation ← the owner's saturation, scaled by each reference step's
 *                saturation RATIO to reference step 600;
 *   lightness  ← each reference step's lightness, shifted by the difference
 *                between the owner's lightness and reference step 600's.
 *
 * The hue OFFSET matters and was got wrong once: the shipped ramp is not a
 * single hue. Step 600 is at 19.4° and step 100 at 25.7° — the designer warmed
 * the light end by hand, so a pale step reads as peach rather than as washed-out
 * 600. Pinning every step to the owner's single hue threw exactly that
 * hand-tuning away, and made the "feeding the shipped primary back reproduces
 * the shipped ramp" claim below FALSE by up to 4/255 per channel. Carrying the
 * offset makes the claim exactly true (the anchor's offset is 0 by
 * construction) and gives every other owner the same designed drift.
 *
 * Step 600 is the anchor because that is what the shipped primary already is:
 * `DEFAULT_BRAND_IDENTITY.primaryColor` is `#a8481a`, which is
 * `--color-brand-600` verbatim, and it is the `themeColor` the root layout
 * already declares. So feeding the default palette through this function
 * reproduces the shipped ramp (to within HSL round-trip rounding) rather than
 * quietly re-tinting an app nobody asked to re-tint — which is the property
 * that makes this derivation testable at all.
 *
 * REJECTED — a fixed lightness ladder (`L = 97, 92, 84, …`) ignoring the
 * reference. It is simpler, but the shipped ramp is not a linear ladder: it
 * desaturates towards the light end (a 90%-saturated pale peach looks like a
 * highlighter) and holds saturation towards the dark end. A linear ladder
 * throws that hand-tuning away for every owner including the default one.
 *
 * REJECTED — interpolating in OKLab for perceptual uniformity. It is the
 * better colour space and it would be the right answer if we were inventing a
 * ramp. We are not: we are copying the shape of a ramp a designer already
 * tuned by eye, and doing that in the space it was tuned in (HSL, which is
 * what the hex values were picked against) reproduces it exactly. Adding a
 * colour-space conversion library for a nine-value lookup would also be a new
 * runtime dependency for a cosmetic gain.
 *
 * KNOWN LIMIT, stated rather than hidden: an owner who picks a very light or
 * very desaturated primary gets a ramp whose dark end is not as dark as the
 * shipped one, because the lightness shift clamps rather than compressing.
 * `bg-brand-600` text-on-colour could then fall below AA contrast. The Brand
 * panel previews a real document so the effect is visible before saving, and
 * the app's TEXT tokens are deliberately not derived from the brand at all
 * (see `brandCssVariables`), so body copy stays readable whatever happens
 * here.
 */

/**
 * `globals.css`'s `--color-brand-*`, transcribed. This is the SHAPE the
 * derivation copies, not a fallback: it is read for its hue-relative
 * saturation and its lightness spacing, never emitted as-is.
 *
 * It is duplicated from CSS on purpose. The alternative — reading the computed
 * value of `--color-brand-500` off `document.documentElement` — would make the
 * derivation depend on the very variables it is about to overwrite, so the
 * second call would derive from the first call's output and drift a little
 * further every time the owner saved.
 */
const REFERENCE_RAMP: Readonly<Record<BrandRampStep, string>> = {
  50: '#fdf3ec',
  100: '#fbe3d1',
  200: '#f5c6a3',
  300: '#eda06e',
  400: '#e17a3f',
  500: '#c85f26',
  600: '#a8481a',
  700: '#863814',
  800: '#6b2d12',
  900: '#4f2110',
};

export type BrandRampStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export const BRAND_RAMP_STEPS: readonly BrandRampStep[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900,
];

/** The step the owner's `primaryColor` IS. See the header. */
const ANCHOR_STEP: BrandRampStep = 600;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX = /^#([0-9a-fA-F]{6})$/;

/** `#rrggbb` → HSL, or `null` when the string is not one. */
export function hexToHsl(hex: string): Hsl | null {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) return null;
  const int = parseInt(match[1], 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** HSL → `#rrggbb`. */
export function hslToHex({ h, s, l }: Hsl): string {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hue = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const toByte = (v: number) =>
    Math.round(clamp((v + m) * 255, 0, 255))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(rgb[0])}${toByte(rgb[1])}${toByte(rgb[2])}`;
}

/**
 * The nine-step (ten, counting 50) UI ramp for one primary colour.
 *
 * A primary that is not a valid `#rrggbb` returns the shipped ramp untouched
 * rather than throwing: this runs on every page load from a settings value
 * that outlives any one release, and an app that fails to paint is worse than
 * an app painted in last release's terracotta.
 */
export function deriveBrandRamp(primaryColor: string): Record<BrandRampStep, string> {
  const primary = hexToHsl(primaryColor);
  const anchor = hexToHsl(REFERENCE_RAMP[ANCHOR_STEP]);
  if (!primary || !anchor) return { ...REFERENCE_RAMP };

  const lightnessShift = primary.l - anchor.l;
  // A reference step with zero saturation would make the ratio meaningless;
  // the shipped ramp has none, but the guard keeps a future re-tint safe.
  const anchorSaturation = anchor.s === 0 ? 1 : anchor.s;

  const ramp = {} as Record<BrandRampStep, string>;
  for (const step of BRAND_RAMP_STEPS) {
    if (step === ANCHOR_STEP) {
      // The anchor is emitted verbatim, not round-tripped through HSL, so
      // `--color-brand-600` is EXACTLY the hex the owner picked. A one-digit
      // rounding drift there would show up as the primary button not quite
      // matching the swatch in the Brand panel.
      ramp[step] = normalizeHex(primaryColor) ?? REFERENCE_RAMP[step];
      continue;
    }
    const reference = hexToHsl(REFERENCE_RAMP[step]);
    if (!reference) {
      ramp[step] = REFERENCE_RAMP[step];
      continue;
    }
    ramp[step] = hslToHex({
      // `hslToHex` normalises hue back into [0, 360), so a step whose offset
      // carries the sum past either end wraps rather than clamping — hue is a
      // circle, and clamping it would flatten the drift at exactly the
      // reds/magentas where a food brand is most likely to sit.
      h: primary.h + (reference.h - anchor.h),
      s: clamp((primary.s * reference.s) / anchorSaturation, 0, 100),
      l: clamp(reference.l + lightnessShift, 2, 98),
    });
  }
  return ramp;
}

/** Lower-cased `#rrggbb`, or null. */
export function normalizeHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
}

export function isHexColor(value: string): boolean {
  return normalizeHex(value) !== null;
}

/**
 * The complete set of CSS custom properties a brand identity contributes, as
 * a plain map so the caller decides where to put them (`:root` at runtime, an
 * inline `style` on a preview, a test assertion).
 *
 * WHAT IS DELIBERATELY NOT HERE: `--color-text-primary`, `--color-text-muted`,
 * `--color-surface*` and the rest of the neutral scale. The owner's `inkColor`
 * and `mutedColor` are DOCUMENT colours — the ink an invoice's body text is
 * printed in. Wiring them into the app's text tokens would let a brand setting
 * make every screen in the system unreadable, and it would do it from a panel
 * whose preview only shows a piece of paper. They are exposed as their own
 * variables (`--color-brand-ink`, `--color-brand-muted`) for anything that
 * genuinely wants the document colours on screen, and the app's warm-stone
 * text scale stays exactly where `globals.css` put it.
 *
 * `--color-ring` is already `var(--color-brand-500)` in `globals.css`, so
 * focus rings follow the ramp with no extra work here.
 */
export function brandCssVariables(identity: BrandIdentity): Record<string, string> {
  const ramp = deriveBrandRamp(identity.primaryColor);
  const variables: Record<string, string> = {};
  for (const step of BRAND_RAMP_STEPS) {
    variables[`--color-brand-${step}`] = ramp[step];
  }
  variables['--color-brand-accent'] = normalizeHex(identity.accentColor) ?? ramp[500];
  variables['--color-brand-ink'] = normalizeHex(identity.inkColor) ?? ramp[900];
  variables['--color-brand-muted'] = normalizeHex(identity.mutedColor) ?? ramp[400];
  return variables;
}

/**
 * The four colours a `DocTemplate`'s `brand.*` tokens resolve against.
 *
 * A thin wrapper over `@mimi/shared`'s `brandPalette` that additionally
 * NORMALISES each value, because this one feeds `resolveDocColor`, which
 * validates against `/^#[0-9a-fA-F]{6}$/` and silently falls back to `ink` for
 * anything else — so an identity holding `#ABC` would print an entire document
 * in one colour with no error anywhere.
 */
export function documentPalette(identity: BrandIdentity, fallback: BrandPalette): BrandPalette {
  return {
    primary: normalizeHex(identity.primaryColor) ?? fallback.primary,
    accent: normalizeHex(identity.accentColor) ?? fallback.accent,
    ink: normalizeHex(identity.inkColor) ?? fallback.ink,
    muted: normalizeHex(identity.mutedColor) ?? fallback.muted,
  };
}
