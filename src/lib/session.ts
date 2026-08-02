import { createHmac } from 'node:crypto'

export interface SessionUser {
  id: string
  stellarAddress: string
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Mints a Supabase-compatible HS256 access token for a wallet-authenticated
 * user. Signed with the project's SUPABASE_JWT_SECRET, so Supabase accepts it
 * and RLS policies keyed on `auth.uid()` (== sub) work for the user.
 */
export function mintAccessToken(user: SessionUser): string {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not set')

  // GoTrue only accepts tokens with the same iss/ref claims as the project's
  // own JWTs — otherwise getUser() and RLS reject them.
  const ref =
    process.env.SUPABASE_PROJECT_REF ??
    new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname.split('.')[0]

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: 'supabase',
    ref,
    role: 'authenticated',
    aud: 'authenticated',
    sub: user.id,
    stellar_address: user.stellarAddress,
    iat: now,
    exp: now + 24 * 60 * 60,
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

/** Decodes and validates a token we minted (used to protect our own routes). */
export function verifyAccessToken(token: string): SessionUser | null {
  try {
    const secret = process.env.SUPABASE_JWT_SECRET
    if (!secret) return null

    const [headerB64, payloadB64, signatureB64] = token.split('.')
    if (!headerB64 || !payloadB64 || !signatureB64) return null

    const expected = createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url')
    if (expected !== signatureB64) return null

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      sub?: string
      stellar_address?: string
      exp?: number
    }
    if (!payload.sub || !payload.stellar_address) return null
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }
    return { id: payload.sub, stellarAddress: payload.stellar_address }
  } catch {
    return null
  }
}
