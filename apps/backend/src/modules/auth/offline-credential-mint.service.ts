/**
 * Offline-authorization credential MINTING (D-17, SYNC-PROTOCOL §7.2) — the
 * M01 half `kernel/sync/binding-crypto.ts`'s coordination note names ("mint
 * `k` with `randomBytes(32)`, call `encryptBindingSecret(k, encKey)` and
 * store the result in `offline_credentials.binding_secret_enc`, using the
 * SAME `OFFLINE_CREDENTIAL_ENC_KEY` env var"). Re-verification (§7.4) is
 * `kernel/sync/offline-auth.service.ts`'s job and is not touched here.
 *
 * SCOPE GATING — the §7.6 closed list, made data-driven rather than
 * hardcoded per role, because two of the three scope keys resolve to a
 * SINGLE RBAC permission key shared by roles §7.6 explicitly excludes
 * (`waste.approve` is held by `kepala_gudang` too, but only the OUTLET step
 * — i.e. `supervisor` — is D-17-eligible; the gudang step is online-only,
 * SYNC-PROTOCOL §3.3 group 9 / CONTRACTS §5.10):
 *   - `void_refund.approve`  <- `pos.void.approve`               (owner/manager/supervisor all eligible; §7.6 names no
 *                                                                  step qualifier for this scope, unlike the other two)
 *   - `replenishment.supervisor_approve` <- `replenishment.approve.supervisor` (owner/manager/supervisor)
 *   - `waste.approve`        <- `waste.approve`, role === 'supervisor' ONLY (excludes kepala_gudang's gudang-step use
 *                                                                             of the same permission key)
 *
 * CAP DERIVATION — `AuthRepository.nextStepMinAmount`: the min_amount of the
 * step immediately above this role's own step in `approval_chain_steps`, if
 * one exists (§5.2's void_refund chain: supervisor step 1 uncapped in the
 * table, manager step 2 min_amount=200000.00 — the supervisor's *effective*
 * offline ceiling per §5.2's own footnote: "an offline approval above the
 * supervisor's scope cap... is impossible to record"). Replenishment's step
 * 2 has no min_amount (no cap) and waste has no step 2 at all (no cap) —
 * both correctly fall through to "uncapped", matching SYNC-PROTOCOL §7.2's
 * own example (`replenishment.supervisor_approve: {}`). For owner/manager
 * (who outrank every step — `ROLE_RANK`), no cap is applied: there is no
 * step "above" the top of the chain for them.
 *
 * KNOWN CROSS-TEAM GAP (flagged in the final report, not fixed here —
 * `kernel/sync/**` is W2-D's frozen territory): §7.4 check 6 in
 * `offline-auth.service.ts` calls `OfflineCredentialsRepository
 * .userHoldsLocation`, which queries ONLY `user_locations` — it has no
 * `app_is_central()`-style bypass for owner/manager, who typically hold NO
 * `user_locations` row at all (they see every location via role, not
 * assignment). An owner/manager's offline-provisional approval would
 * therefore always fail re-verification's check 6 today. This module still
 * mints for owner/manager (matching the RBAC grant on
 * `auth.offline_credential.mint`) since minting itself is harmless and the
 * bug is downstream of this file.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  can,
  DEFAULT_OFFLINE_APPROVAL_VOLUME_CAP,
  DEFAULT_OFFLINE_CREDENTIAL_TTL_HOURS,
  DEFAULT_OFFLINE_SELFIE_REQUIRED_ABOVE,
  type Money,
  type OfflineCredentialRes,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { encKeyFromConfig, encryptBindingSecret } from '../../kernel/sync/binding-crypto';
import { AuthRepository } from './auth.repository';
import {
  encodeOfflineCredentialToken,
  type OfflineCredentialClaims,
} from './offline-credential-token.util';

interface ScopeRule {
  key: 'void_refund.approve' | 'replenishment.supervisor_approve' | 'waste.approve';
  documentType: string;
  /** Which role(s) may be minted this scope; `waste.approve` narrows to the literal outlet-step role. */
  eligible(roleKey: string): boolean;
}

const SCOPE_RULES: ScopeRule[] = [
  {
    key: 'void_refund.approve',
    documentType: 'void_refund',
    eligible: (r) => can(r as RoleKey, 'pos.void.approve'),
  },
  {
    key: 'replenishment.supervisor_approve',
    documentType: 'replenishment_request',
    eligible: (r) => can(r as RoleKey, 'replenishment.approve.supervisor'),
  },
  { key: 'waste.approve', documentType: 'waste', eligible: (r) => r === 'supervisor' },
];

export interface MintInput {
  userId: UUID;
  username: string;
  roleKey: string;
  deviceId: UUID | null;
  pinHash: string | null;
  locationIds: UUID[];
}

@Injectable()
export class OfflineCredentialMintService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns `null` when the role qualifies for no closed-list scope at all,
   * or the user has not yet set a PIN (a credential without a `pin_verifier`
   * cannot exist — the column is `NOT NULL`, and a PIN-less approver could
   * never satisfy §7.3's local PIN gate anyway). Otherwise mints ONE
   * `offline_credentials` row covering every scope the role qualifies for,
   * superseding any still-live credential for the same (user, device) pair.
   */
  async mint(client: PoolClient, input: MintInput): Promise<OfflineCredentialRes | null> {
    if (!input.pinHash) return null;

    // Two representations of the same scope caps: `offline_credentials.scopes`
    // (DB storage) is read back snake_case (`scope.max_idr`) by
    // `kernel/sync/offline-auth.service.ts`'s §7.4 re-verification — frozen,
    // not this agent's to change. The wire (`OfflineCredentialRes.scopes` /
    // the token's own `claims.scopes`) is camelCase (`maxIdr`), matching
    // `packages/shared`'s `OfflineCredentialRes` type AND the frontend's
    // already-shipped `cached.claims.scopes[key].maxIdr` reader. Both are
    // built from the same cap value so they never drift from each other.
    const scopesDb: Record<string, { max_idr?: Money }> = {};
    const scopesWire: Record<string, { maxIdr?: Money }> = {};
    for (const rule of SCOPE_RULES) {
      if (!rule.eligible(input.roleKey)) continue;
      const cap =
        input.roleKey === 'supervisor'
          ? await this.repo.nextStepMinAmount(client, rule.documentType, 'supervisor')
          : null;
      scopesDb[rule.key] = cap ? { max_idr: cap } : {};
      scopesWire[rule.key] = cap ? { maxIdr: cap } : {};
    }
    if (Object.keys(scopesDb).length === 0) return null;

    await this.repo.revokeLiveCredentialsForUserDevice(client, input.userId, input.deviceId);

    const credentialId = randomUUID();
    const k = randomBytes(32);
    const encKey = encKeyFromConfig(this.config);
    const bindingSecretEnc = encryptBindingSecret(k, encKey);

    const ttlHours =
      (await this.repo.getSettingValue<number>(client, 'auth.offline_credential_ttl_h')) ??
      DEFAULT_OFFLINE_CREDENTIAL_TTL_HOURS;
    const selfieAbove =
      (await this.repo.getSettingValue<Money>(client, 'offline.selfie_required_above')) ??
      DEFAULT_OFFLINE_SELFIE_REQUIRED_ABOVE;
    const volumeCap =
      (await this.repo.getSettingValue<number>(client, 'offline.approval_volume_cap')) ??
      DEFAULT_OFFLINE_APPROVAL_VOLUME_CAP;

    const mintedAt = new Date();
    const expiresAt = new Date(mintedAt.getTime() + ttlHours * 3_600_000);

    await this.repo.insertOfflineCredential(client, {
      credentialId,
      userId: input.userId,
      deviceId: input.deviceId,
      roleKey: input.roleKey,
      locationIds: input.locationIds,
      scopes: scopesDb,
      bindingSecretEnc,
      pinVerifier: input.pinHash,
      selfieRequiredAbove: selfieAbove,
      volumeCap,
      expiresAt: expiresAt.toISOString(),
    });

    const claims: OfflineCredentialClaims = {
      credentialId,
      sub: input.userId,
      role: input.roleKey,
      locationIds: input.locationIds,
      scopes: scopesWire,
      iat: mintedAt.toISOString(),
      exp: expiresAt.toISOString(),
      k: k.toString('base64'),
      pinVerifier: input.pinHash,
      selfieRequiredAboveIdr: selfieAbove,
    };

    return {
      credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: scopesWire,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
