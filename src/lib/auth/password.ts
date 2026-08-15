import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/**
 * Hashes a password with a random salt using Node's built-in scrypt.
 * Returns `salt:hash` as a single opaque string.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verifies a plaintext password against a stored `salt:hash` string in
 * constant time.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const separatorIndex = stored.indexOf(":");
  if (separatorIndex <= 0) return false;

  const salt = stored.slice(0, separatorIndex);
  const hash = stored.slice(separatorIndex + 1);
  if (!salt || !hash) return false;

  try {
    const expected = Buffer.from(hash, "hex");
    const candidate = scryptSync(password, salt, expected.length);
    return expected.length === candidate.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
