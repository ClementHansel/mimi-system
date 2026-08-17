/**
 * Tiny duration-string parser for JWT-style shorthand (`'15m'`, `'7d'`,
 * `'1h'`, `'30s'`) — mirrors what `jsonwebtoken`'s `expiresIn` accepts
 * (`common/jwt/token.service.ts`), so `sessions.expires_at` can be derived
 * from the SAME `JWT_REFRESH_EXPIRES_IN` env var without a second config
 * source of truth. Deliberately self-contained (no new dependency) — see
 * BUILD-PLAN §6 rule 2 on dependency requests.
 */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(spec: string, fallbackMs: number): number {
  const match = /^(\d+)\s*([smhd])$/.exec(spec.trim());
  if (!match) return fallbackMs;
  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  const unitMs = UNIT_MS[unit!];
  if (!Number.isFinite(amount) || !unitMs) return fallbackMs;
  return amount * unitMs;
}
