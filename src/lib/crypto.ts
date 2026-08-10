/**
 * Secret hashing with Node's built-in scrypt — no external dependencies.
 * Stored format: "scrypt:<saltHex>:<hashHex>".
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

const KEYLEN = 64

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(secret, salt, KEYLEN)) as Buffer
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    const derived = (await scrypt(secret, salt, expected.length)) as Buffer
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// Largest multiple of 1,000,000 below 2^32 — drawing only from this range
// keeps the modulo uniform (rejects ~0.02% of samples, negligible).
const OTP_DRAW_LIMIT = 4_294_000_000

/** Cryptographically uniform 6-digit code, zero-padded (e.g. "004231"). */
export function randomOtpCode(): string {
  let n: number
  do {
    n = randomBytes(4).readUInt32BE(0)
  } while (n >= OTP_DRAW_LIMIT)
  return (n % 1000000).toString().padStart(6, '0')
}
