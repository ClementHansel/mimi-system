/**
 * Reads the `settings` rows every document resolver needs regardless of
 * kind: the brand palette and the company logo. Follows
 * `modules/hr/hr-settings.util.ts`'s `readSetting` pattern exactly — `settings`
 * is class M (cloud-authoritative, read-only elsewhere per CONTRACTS.md
 * §1.14), so a direct read-only SELECT from this module, on the request's
 * own `PoolClient`, is the established shape rather than a new one.
 */
import type { PoolClient } from 'pg';
import {
  brandPalette,
  DEFAULT_BRAND_IDENTITY,
  type BrandIdentity,
  type BrandPalette,
} from '@mimi/shared';

async function readSetting<T>(client: PoolClient, key: string, fallback: T): Promise<T> {
  const res = await client.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    key,
  ]);
  if (res.rows.length === 0 || res.rows[0]!.value === null || res.rows[0]!.value === undefined)
    return fallback;
  return res.rows[0]!.value as T;
}

/**
 * `brand.identity` → `BrandPalette`. Falls back to `DEFAULT_BRAND_IDENTITY`
 * on a missing OR malformed row rather than throwing: a document must print
 * even if an owner's settings row is somehow corrupt, the same "recoverable
 * beats broken" reasoning `resolveDocColor` (`@mimi/shared`) already applies
 * to a single bad colour. "Malformed" here is deliberately loose (anything
 * that isn't a plain object with the four expected string colours) — this
 * is a resolver reading data an Admin screen already validated on write via
 * `settings-value-validator.ts`, not a second validation layer for it.
 */
export async function getBrandPalette(client: PoolClient): Promise<BrandPalette> {
  const identity = await readSetting<Partial<BrandIdentity>>(client, 'brand.identity', {});
  const isWellFormed =
    typeof identity.primaryColor === 'string' &&
    typeof identity.accentColor === 'string' &&
    typeof identity.inkColor === 'string' &&
    typeof identity.mutedColor === 'string';
  return brandPalette(isWellFormed ? (identity as BrandIdentity) : DEFAULT_BRAND_IDENTITY);
}

export interface CompanyProfile {
  name: string;
  address: string;
  city: string;
  logoAttachmentId: string | null;
}

const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  name: '',
  address: '',
  city: '',
  logoAttachmentId: null,
};

/**
 * `company.profile` (`settings-value-validator.ts`'s schema: `name`,
 * `address`, `city`, `logoAttachmentId`). Falls back to an all-empty profile
 * on a missing/malformed row — same "a document must print" reasoning as
 * `getBrandPalette`.
 *
 * NOTE — `company_phone` and `company_npwp` field tokens (`INVOICE_FIELD_TOKENS`,
 * `SURAT_JALAN_FIELD_TOKENS`) have NO settings-backed source today:
 * `company.profile`'s schema carries no phone/NPWP field, and no other
 * seeded settings key does either. Every invoice/SJ resolver therefore fills
 * those two tokens with `''` — a real, empty string (satisfying the
 * `Record<...FieldToken, string>` completeness type, which only requires a
 * STRING, not a non-empty one) rather than a compile error or a thrown
 * exception. This is flagged here, once, rather than at each of the two
 * resolver call sites, as a gap for the architect/settings owner: adding a
 * `companyPhone`/`companyNpwp` (or extending `company.profile`) settings
 * field is out of this ticket's scope (`packages/shared` is frozen for this
 * agent) and belongs to whoever owns `company.profile` next.
 */
export async function getCompanyProfile(client: PoolClient): Promise<CompanyProfile> {
  const profile = await readSetting<Partial<CompanyProfile>>(client, 'company.profile', {});
  return {
    name: typeof profile.name === 'string' ? profile.name : EMPTY_COMPANY_PROFILE.name,
    address: typeof profile.address === 'string' ? profile.address : EMPTY_COMPANY_PROFILE.address,
    city: typeof profile.city === 'string' ? profile.city : EMPTY_COMPANY_PROFILE.city,
    logoAttachmentId: profile.logoAttachmentId ?? null,
  };
}

/** `company.profile.logoAttachmentId` — the same key `brand.ts`'s header explains is deliberately NOT duplicated onto `brand.identity`. */
export async function getLogoAttachmentId(client: PoolClient): Promise<string | null> {
  return (await getCompanyProfile(client)).logoAttachmentId;
}
