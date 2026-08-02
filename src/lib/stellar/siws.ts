import { createHash } from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'

export function buildSignInMessage(nonce: string): string {
  return `AnieLab sign-in\n\nNonce: ${nonce}`
}

/**
 * Verifies an Ed25519 signature over the SHA-256 digest of the sign-in message.
 *
 * NOTE: once Freighter's `signMessage` (SEP-30 SIWS) is stabilized, swap this
 * for the SEP-30 payload verification. This covers the testnet flow today.
 */
export function verifySignature(
  publicKey: string,
  nonce: string,
  signatureBase64: string
): boolean {
  try {
    const kp = Keypair.fromPublicKey(publicKey)
    const digest = createHash('sha256')
      .update(buildSignInMessage(nonce))
      .digest()
    return kp.verify(digest, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}
