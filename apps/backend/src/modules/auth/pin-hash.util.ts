/**
 * Argon2id PIN hashing (D-17, SYNC-PROTOCOL §7.2: "argon2id hash of approver
 * PIN (memory-hard: m=64MiB, t=3, p=1)"). Backed by `hash-wasm` — the same
 * pure WASM primitive already vetted and shipped for this exact algorithm in
 * `apps/frontend/src/lib/local/credentials/pin-verifier.ts` (there used only
 * for `argon2Verify`; here we ALSO need the hashing half, since M01 is where
 * a PIN is first set — `/api/auth/pin` — and where `offline_credentials
 * .pin_verifier` is minted from `users.pin_hash`, per that file's own
 * coordination note).
 *
 * `users.pin_hash VARCHAR(255)` comfortably fits the PHC-encoded output
 * (`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`, ~95 chars for a 16-byte
 * salt + 32-byte digest).
 */
import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes } from 'node:crypto';

const MEMORY_SIZE_KIB = 64 * 1024; // 64 MiB, per §7.2
const ITERATIONS = 3;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_BYTES = 16;

const PIN_RE = /^\d{6}$/;

export function isValidPinFormat(pin: string): boolean {
  return PIN_RE.test(pin);
}

/** Hashes a 6-digit PIN into a PHC-encoded argon2id string (§7.2 parameters). */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return argon2id({
    password: pin,
    salt,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    memorySize: MEMORY_SIZE_KIB,
    hashLength: HASH_LENGTH,
    outputType: 'encoded',
  });
}

/** Verifies a submitted PIN against a stored argon2id PHC hash (constant-time internally, per hash-wasm). */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return argon2Verify({ password: pin, hash });
}
