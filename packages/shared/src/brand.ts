/**
 * Brand identity — the logo, the favicon, and the four colours every printed
 * document and every browser tab is drawn from.
 *
 * WHERE THE LOGO LIVES, AND WHY IT IS NOT IN THIS OBJECT
 * -----------------------------------------------------
 * `company.profile.logoAttachmentId` already existed (settings key, seeded in
 * migration 007, validated by `settings-value-validator.ts`) and is already
 * the company's logo. Adding a second `logoAttachmentId` here would create two
 * places to set one thing, and the first screen to read the wrong one prints a
 * blank letterhead. So the logo stays where it is; `brand.identity` carries
 * only what had nowhere to live: the favicon and the palette. The Brand panel
 * in Admin writes BOTH keys, which is why an owner never has to know this.
 *
 * WHY FOUR COLOURS AND NOT A FULL THEME. A document needs exactly: the colour
 * of the brand (headings, table header fills), an accent that survives next to
 * it (values, emphasis), an ink for body text, and a muted for secondary text.
 * The app's own UI ramp (`--color-brand-50..900` in globals.css) is a
 * different job — it needs nine steps for hover/active/disabled states, which
 * paper does not have. Mapping four to nine is a frontend concern
 * (`lib/brand/palette.ts`); a template only ever names these four
 * (`BrandColorToken` in `documents/template.ts`).
 */

import type { BrandPalette } from './documents/template';

export interface BrandIdentity {
  /** `attachments.id` of the favicon/app icon. `null` = fall back to the shipped `/icons/*`. */
  faviconAttachmentId: string | null;
  /** `#rrggbb`. */
  primaryColor: string;
  accentColor: string;
  inkColor: string;
  mutedColor: string;
}

/**
 * The shipped Mimi Chicken palette, transcribed from `globals.css`'s
 * `--color-brand-*` ramp so a fresh install prints in the same terracotta the
 * app is already painted in rather than in a placeholder blue:
 * primary = brand-600 (the `themeColor` the root layout already declares),
 * accent = brand-500, ink = stone-900, muted = stone-500.
 */
export const DEFAULT_BRAND_IDENTITY: BrandIdentity = {
  faviconAttachmentId: null,
  primaryColor: '#a8481a',
  accentColor: '#c85f26',
  inkColor: '#1c1917',
  mutedColor: '#78716c',
};

/** The palette a `DocTemplate`'s `brand.*` colour tokens resolve against. */
export function brandPalette(identity: BrandIdentity): BrandPalette {
  return {
    primary: identity.primaryColor,
    accent: identity.accentColor,
    ink: identity.inkColor,
    muted: identity.mutedColor,
  };
}

export const DEFAULT_BRAND_PALETTE: BrandPalette = brandPalette(DEFAULT_BRAND_IDENTITY);
