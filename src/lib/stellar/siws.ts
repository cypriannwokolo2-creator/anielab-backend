import { createHash } from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'

export function buildSignInMessage(nonce: string): string {
  return `AnieLab sign-in\n\nNonce: ${nonce}`
}

export interface SignatureInput {
  /** Bare Ed25519 signature (base64) — legacy flow. */
  signature?: string
  /** SEP-30 SIWS payload (base64): magic + version + msgLen + message + 64-byte signature. */
  signedMessage?: string
}

function tryVerify(kp: Keypair, data: Buffer, signatureBase64: string): boolean {
  try {
    return kp.verify(data, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/**
 * Verifies an Ed25519 signature over the sign-in message. Accepts both the
 * SEP-30 SIWS payload produced by Freighter's signMessage and a bare
 * signature over the message (raw or sha256 digest).
 */
export function verifySignature(
  publicKey: string,
  nonce: string,
  input: SignatureInput
): boolean {
  try {
    const kp = Keypair.fromPublicKey(publicKey)
    const message = Buffer.from(buildSignInMessage(nonce), 'utf8')

    if (input.signature) {
      if (tryVerify(kp, message, input.signature)) return true
      if (tryVerify(kp, createHash('sha256').update(message).digest(), input.signature)) {
        return true
      }
    }

    if (input.signedMessage) {
      const payload = Buffer.from(input.signedMessage, 'base64')
      // SEP-30: payload = prefix(4+2+4+len(message) bytes) + message + signature(64)
      if (payload.length >= 74) {
        const signature = payload.subarray(payload.length - 64).toString('base64')
        const prefix = payload.subarray(0, payload.length - 64)
        if (tryVerify(kp, prefix, signature)) return true
      }
    }

    return false
  } catch {
    return false
  }
}
