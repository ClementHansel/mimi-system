'use client';

import { api } from '@/lib/api';
import { DEFAULT_BRAND_IDENTITY, type BrandIdentity } from '@/lib/shared-types';
import { normalizeHex } from './palette';

/**
 * Reading and writing the brand identity, which lives in TWO settings keys and
 * not one.
 *
 * `packages/shared/src/brand.ts` records why: `company.profile.logoAttachmentId`
 * already existed (seeded in migration 007, type-checked by
 * `settings-value-validator.ts`) and already IS the company's logo. Adding a
 * second `logoAttachmentId` to `brand.identity` would have created two places
 * to set one thing, and the first screen to read the wrong one prints a blank
 * letterhead. So the logo stayed where it was and `brand.identity` carries only
 * what had nowhere to live — the favicon and the four colours.
 *
 * The cost of that decision is paid HERE, in this file, on purpose: the Brand
 * panel writes two keys, and every other caller reads one object. An owner
 * never has to know there are two.
 */

export const BRAND_IDENTITY_KEY = 'brand.identity';
export const COMPANY_PROFILE_KEY = 'company.profile';

/**
 * `GET /settings/:key`'s envelope is not pinned down by the contract we are
 * building against, and the settings LIST endpoint returns rows shaped
 * `{ key, value, description, updatedBy, updatedAt }` (see
 * `components/admin/types.ts`'s `Setting`). So a single-key read may hand back
 * either the row or the bare value depending on how the backend module lands.
 *
 * Rather than guess and 500 the whole app's theming on a mismatch, unwrap
 * whichever arrived. This is a deliberately small, contained piece of tolerance
 * at ONE boundary — it is not a licence to make the rest of the app
 * shape-agnostic, and it should be deleted once the endpoint is pinned.
 */
function unwrapSettingValue(response: unknown): unknown {
  if (response && typeof response === 'object' && !Array.isArray(response) && 'value' in response) {
    return (response as { value: unknown }).value;
  }
  return response;
}

/**
 * Coerce whatever the settings row holds into a usable `BrandIdentity`.
 *
 * Every colour is validated and falls back INDEPENDENTLY to the shipped
 * default. A whole-object fallback would be worse: an owner who has set three
 * colours and typo'd the fourth would see all four revert, and would have no
 * way to tell which one the server rejected.
 */
export function coerceBrandIdentity(raw: unknown): BrandIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BRAND_IDENTITY };
  const value = raw as Partial<Record<keyof BrandIdentity, unknown>>;
  const color = (key: 'primaryColor' | 'accentColor' | 'inkColor' | 'mutedColor'): string => {
    const candidate = value[key];
    return (typeof candidate === 'string' ? normalizeHex(candidate) : null) ?? DEFAULT_BRAND_IDENTITY[key];
  };
  return {
    faviconAttachmentId:
      typeof value.faviconAttachmentId === 'string' ? value.faviconAttachmentId : null,
    primaryColor: color('primaryColor'),
    accentColor: color('accentColor'),
    inkColor: color('inkColor'),
    mutedColor: color('mutedColor'),
  };
}

export async function getBrandIdentity(): Promise<BrandIdentity> {
  const response = await api.get<unknown>(`/settings/${BRAND_IDENTITY_KEY}`);
  return coerceBrandIdentity(unwrapSettingValue(response));
}

export async function putBrandIdentity(identity: BrandIdentity): Promise<BrandIdentity> {
  const response = await api.put<unknown>(`/settings/${BRAND_IDENTITY_KEY}`, { value: identity });
  return coerceBrandIdentity(unwrapSettingValue(response));
}

/**
 * `company.profile` is a heterogeneous object (name, address, npwp, …) that
 * predates this feature and that other screens edit. We only ever touch
 * `logoAttachmentId`, so reads return the WHOLE object and writes merge into
 * it — `SettingDetailModal.buildValue` records exactly this hazard ("a value
 * may carry fields the registry does not know about … dropping them on save
 * would be a silent data loss"), and the Brand panel must not regress it.
 */
export type CompanyProfile = Record<string, unknown> & { logoAttachmentId?: string | null };

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const value = unwrapSettingValue(await api.get<unknown>(`/settings/${COMPANY_PROFILE_KEY}`));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CompanyProfile)
    : {};
}

/**
 * Set (or clear) the company logo WITHOUT touching any other key of
 * `company.profile`. Takes the profile it should merge into rather than
 * re-reading it, so the caller controls the read-modify-write window and a
 * stale copy cannot be resurrected by a background refresh between the two.
 */
export async function putCompanyLogo(
  profile: CompanyProfile,
  logoAttachmentId: string | null,
): Promise<CompanyProfile> {
  const next: CompanyProfile = { ...profile, logoAttachmentId };
  const value = unwrapSettingValue(
    await api.put<unknown>(`/settings/${COMPANY_PROFILE_KEY}`, { value: next }),
  );
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CompanyProfile)
    : next;
}
