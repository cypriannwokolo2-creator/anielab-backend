import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.js'

/**
 * At-rest encryption for secrets stored in the DB (deployer secret key).
 * AES-256-GCM keyed from ADMIN_SESSION_SECRET, falling back to a hash of the
 * Supabase service role key — so no extra env var is strictly required.
 *
 * Stored format: enc:v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 */
const PREFIX = 'enc:v1:'

function encryptionKey(): Buffer {
  const source = config.adminSessionSecret || config.supabaseServiceKey
  return createHash('sha256').update(source).digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/** Returns null when the value can't be decrypted (tampered or wrong key). */
export function decryptSecret(stored: string): string | null {
  if (!stored) return null
  // Pre-encryption legacy values: pass through so nothing breaks on upgrade.
  if (!stored.startsWith(PREFIX)) return stored

  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) return null

  try {
    const iv = Buffer.from(parts[0], 'base64')
    const tag = Buffer.from(parts[1], 'base64')
    const ciphertext = Buffer.from(parts[2], 'base64')
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
