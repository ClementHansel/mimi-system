import { describe, it, expect } from 'vitest';
import { DEFAULT_BRAND_IDENTITY, DEFAULT_BRAND_PALETTE } from '@/lib/shared-types';
import {
  BRAND_RAMP_STEPS,
  brandCssVariables,
  deriveBrandRamp,
  documentPalette,
  hexToHsl,
  hslToHex,
  isHexColor,
  normalizeHex,
} from './palette';

/**
 * The derivation's whole claim is that it transplants the SHAPE of the shipped
 * terracotta ramp onto an owner's hue. The one property that makes that claim
 * testable — and the reason step 600 is the anchor — is that feeding the
 * shipped primary back in must reproduce the shipped ramp. If it does not, the
 * function is not "derive a ramp like ours", it is "re-tint the app", and
 * every install would drift off the designed palette the moment the brand
 * settings were saved once.
 */

/** `globals.css`'s `--color-brand-*`, the thing the derivation must reproduce. */
const SHIPPED: Record<number, string> = {
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

function channels(hex: string): [number, number, number] {
  const int = parseInt(hex.slice(1), 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/** Max per-channel difference, 0–255. HSL round-tripping costs a digit or two. */
function channelDelta(a: string, b: string): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
}

describe('deriveBrandRamp', () => {
  it('reproduces the shipped ramp from the shipped primary', () => {
    const ramp = deriveBrandRamp(DEFAULT_BRAND_IDENTITY.primaryColor);
    for (const step of BRAND_RAMP_STEPS) {
      const shipped = SHIPPED[step] as string;
      // A tolerance of 2/255 per channel, not exact equality: the derivation
      // goes through HSL, and a round trip of the shipped hexes is not
      // bit-identical. Two levels is far below a visible difference and far
      // above what a wrong FORMULA would produce.
      expect(
        channelDelta(ramp[step], shipped),
        `step ${step}: ${ramp[step]} vs shipped ${shipped}`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('emits the owner`s primary EXACTLY at the anchor step', () => {
    // Not "within tolerance": `--color-brand-600` is what a primary button is
    // painted with, and it sits next to the swatch in the Brand panel. A
    // one-digit rounding drift there is a visible mismatch between the colour
    // an owner picked and the colour they got.
    expect(deriveBrandRamp('#0F766E')[600]).toBe('#0f766e');
  });

  it('keeps the ramp monotonically darkening', () => {
    // The ramp's contract is "50 is the lightest tint, 900 the darkest shade".
    // Every hover/active/disabled state in the design system assumes it.
    const ramp = deriveBrandRamp('#2563eb');
    const lightness = BRAND_RAMP_STEPS.map((step) => hexToHsl(ramp[step])?.l ?? 0);
    for (let i = 1; i < lightness.length; i++) {
      expect(lightness[i]!).toBeLessThanOrEqual(lightness[i - 1]! + 0.01);
    }
  });

  it("moves the whole ramp to the owner's hue, carrying the shipped ramp's designed hue drift", () => {
    // The ramp is NOT flat in hue, and that is deliberate: the shipped
    // terracotta warms towards the light end (600 sits at 19.4°, 100 at
    // 25.7°) so a pale step reads as peach rather than as a washed-out 600.
    // The derivation transplants that offset onto the owner's hue. So the
    // assertion is not "every step equals the owner's hue" — that was the
    // earlier, wrong contract, and it is what made the shipped ramp
    // irreproducible — but "every step sits within the shipped ramp's own
    // drift of it, and the anchor is exactly it".
    const teal = '#0f766e';
    const ramp = deriveBrandRamp(teal);
    const target = hexToHsl(teal)?.h ?? -1;

    const shippedDrift = BRAND_RAMP_STEPS.map(
      (step) => (hexToHsl(SHIPPED[step] as string)?.h ?? 0) - (hexToHsl(SHIPPED[600] as string)?.h ?? 0),
    );
    const maxDrift = Math.max(...shippedDrift.map(Math.abs));

    BRAND_RAMP_STEPS.forEach((step, i) => {
      const hue = hexToHsl(ramp[step])?.h ?? -1;
      // Each step lands at the owner's hue plus THAT step's designed offset.
      expect(Math.abs(hue - (target + shippedDrift[i]!)), `step ${step}`).toBeLessThan(2);
      // And the drift never wanders beyond what the designer actually used.
      expect(Math.abs(hue - target)).toBeLessThanOrEqual(maxDrift + 2);
    });

    expect(hexToHsl(ramp[600])?.h).toBeCloseTo(target, 5);
  });

  it('falls back to the shipped ramp rather than throwing on a bad value', () => {
    // A settings value outlives any one release. An app that fails to paint
    // because somebody stored `#ABC` is worse than one painted in last
    // release's terracotta.
    for (const bad of ['', '#ABC', 'chartreuse', 'rgb(1,2,3)']) {
      expect(deriveBrandRamp(bad)[600]).toBe(SHIPPED[600]);
    }
  });
});

describe('brandCssVariables', () => {
  it('emits every ramp step plus the three document colours', () => {
    const vars = brandCssVariables(DEFAULT_BRAND_IDENTITY);
    for (const step of BRAND_RAMP_STEPS) {
      expect(vars[`--color-brand-${step}`]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(vars['--color-brand-accent']).toBe(DEFAULT_BRAND_IDENTITY.accentColor);
    expect(vars['--color-brand-ink']).toBe(DEFAULT_BRAND_IDENTITY.inkColor);
    expect(vars['--color-brand-muted']).toBe(DEFAULT_BRAND_IDENTITY.mutedColor);
  });

  it('never touches the app`s own text or surface tokens', () => {
    // `inkColor`/`mutedColor` are DOCUMENT colours — the ink an invoice is
    // printed in. Wiring them into `--color-text-primary` would let a brand
    // setting make every screen in the system unreadable, from a panel whose
    // only preview is a piece of paper.
    const vars = brandCssVariables({ ...DEFAULT_BRAND_IDENTITY, inkColor: '#ffffff' });
    expect(Object.keys(vars).some((name) => name.startsWith('--color-text'))).toBe(false);
    expect(Object.keys(vars).some((name) => name.startsWith('--color-surface'))).toBe(false);
  });
});

describe('documentPalette', () => {
  it('normalises every colour so resolveDocColor cannot silently reject one', () => {
    // `resolveDocColor` validates against `/^#[0-9a-fA-F]{6}$/` and falls back
    // to `ink` for anything else — so an identity holding `#ABC` would print an
    // ENTIRE document in one colour, with no error anywhere.
    const palette = documentPalette(
      { ...DEFAULT_BRAND_IDENTITY, primaryColor: '#A8481A', accentColor: 'nope' },
      DEFAULT_BRAND_PALETTE,
    );
    expect(palette.primary).toBe('#a8481a');
    expect(palette.accent).toBe(DEFAULT_BRAND_PALETTE.accent);
  });
});

describe('hex helpers', () => {
  it('round-trips a colour through HSL within a level or two', () => {
    for (const hex of Object.values(SHIPPED)) {
      const hsl = hexToHsl(hex);
      expect(hsl).not.toBeNull();
      expect(channelDelta(hslToHex(hsl!), hex)).toBeLessThanOrEqual(2);
    }
  });

  it('accepts only #rrggbb', () => {
    expect(isHexColor('#a8481a')).toBe(true);
    expect(isHexColor('#A8481A')).toBe(true);
    expect(isHexColor('#abc')).toBe(false);
    expect(isHexColor('a8481a')).toBe(false);
    expect(normalizeHex('  #A8481A  ')).toBe('#a8481a');
  });
});
