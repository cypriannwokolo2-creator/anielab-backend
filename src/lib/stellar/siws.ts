import { createHash } from 'node:crypto'
import { Keypair, hash } from '@stellar/stellar-sdk'

export function buildSignInMessage(nonce: string): string {
  return `AnieLab sign-in\n\nNonce: ${nonce}`
}

export interface SignatureInput {
  /** Bare Ed25519 signature (base64) — legacy flow. */
  signature?: string
  /** Signed message (base64). Wallets produce a SEP-53 signature by default. */
  signedMessage?: string
}

/** SEP-53 domain-separation prefix (also used by Freighter's signMessage). */
const SEP53_PREFIX = Buffer.from('Stellar Signed Message:\n', 'utf8')

/** SHA-256("Stellar Signed Message:\n" + message) — the bytes signed in SEP-53. */
export function sep53Digest(message: Buffer): Buffer {
  return hash(Buffer.concat([SEP53_PREFIX, message]))
}

function tryVerify(kp: Keypair, data: Buffer, signatureBase64: string): boolean {
  try {
    return kp.verify(data, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/**
 * Verifies an Ed25519 signature over the sign-in message. Accepts:
 *  - SEP-53: signature over SHA-256("Stellar Signed Message:\n" + message) —
 *    what Freighter (v4) and the Stellar Wallets Kit produce.
 *  - Legacy bare signature over the raw message or its sha256 digest.
 *  - Legacy SEP-30 SIWS payload (prefix + message + 64-byte signature).
 */
export function verifySignature(
  publicKey: string,
  nonce: string,
  input: SignatureInput
): boolean {
  try {
    const kp = Keypair.fromPublicKey(publicKey)
    const message = Buffer.from(buildSignInMessage(nonce), 'utf8')
    const sep53 = sep53Digest(message)

    // SEP-53 — the standard wallet signature (also `input.signature` after a
    // wallet returns `{ signature }` instead of `{ signedMessage }`).
    if (input.signature) {
      if (tryVerify(kp, sep53, input.signature)) return true
      if (tryVerify(kp, message, input.signature)) return true
      if (tryVerify(kp, createHash('sha256').update(message).digest(), input.signature)) {
        return true
      }
    }

    if (input.signedMessage) {
      // SEP-53: the signedMessage may be just the 64-byte signature (base64).
      if (tryVerify(kp, sep53, input.signedMessage)) return true

      // Legacy SEP-30 SIWS payload: prefix(4+2+4+len) + message + signature(64).
      const payload = Buffer.from(input.signedMessage, 'base64')
      if (payload.length >= 74) {
        const signature = payload.subarray(payload.length - 64).toString('base64')
        const prefix = payload.subarray(0, payload.length - 64)
        if (tryVerify(kp, prefix, signature)) return true
        // Older SEP-30 verification signed the sha256 of the prefix.
        if (tryVerify(kp, createHash('sha256').update(prefix).digest(), signature)) {
          return true
        }
      }
    }

    return false
  } catch {
    return false
  }
}
