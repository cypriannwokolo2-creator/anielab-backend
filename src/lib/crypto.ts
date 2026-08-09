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

/** Cryptographically random 6-digit code (never starts with 0-padding issues). */
export function randomOtpCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1000000
  return n.toString().padStart(6, '0')
}
