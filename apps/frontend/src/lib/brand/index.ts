/**
 * Brand identity — the logo, the favicon and the four colours that every
 * printed document and the running UI are drawn from. Import from here rather
 * than deep-importing a file, so the split between the pure derivation
 * (`palette.ts`), the settings I/O (`brand-api.ts`) and the runtime injection
 * (`BrandProvider.tsx`) stays an implementation detail.
 */
export { BrandProvider, useBrand, type BrandContextValue } from './BrandProvider';
export {
  brandCssVariables,
  deriveBrandRamp,
  documentPalette,
  hexToHsl,
  hslToHex,
  isHexColor,
  normalizeHex,
  BRAND_RAMP_STEPS,
  type BrandRampStep,
} from './palette';
export {
  BRAND_IDENTITY_KEY,
  COMPANY_PROFILE_KEY,
  coerceBrandIdentity,
  getBrandIdentity,
  getCompanyProfile,
  putBrandIdentity,
  putCompanyLogo,
  type CompanyProfile,
} from './brand-api';
