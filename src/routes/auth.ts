import { Router } from 'express'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { buildSignInMessage, verifySignature } from '../lib/siws.js'
import { rateLimit } from '../lib/rateLimit.js'

export const authRouter = Router()

const challengeSchema = z.object({
  stellarAddress: z.string(),
})

const verifySchema = z.object({
  stellarAddress: z.string(),
  nonce: z.string(),
  signature: z.string().optional(),
  signedMessage: z.string().optional(),
  roles: z.array(z.string().max(40)).max(3).optional(),
})

/**
 * POST /api/auth/challenge — mint a one-time sign-in nonce for a wallet.
 */
authRouter.post('/challenge', async (req, res) => {
  const body = challengeSchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: 'invalid request' })
  }
  const { stellarAddress } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return res.status(400).json({ error: 'invalid stellar address' })
  }

  // Don't let one address mint unlimited nonces — an attacker could otherwise
  // fill auth_challenges and spam the sign-in flow.
  if (!rateLimit(`challenge:${stellarAddress}`)) {
    return res.status(429).json({ error: 'too many challenge requests, slow down' })
  }

  const nonce = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { error } = await supabaseAdmin()
    .from('auth_challenges')
    .insert({ stellar_address: stellarAddress, nonce, expires_at: expiresAt })

  if (error) {
    return res.status(500).json({ error: 'challenge creation failed' })
  }

  return res.json({
    nonce,
    message: buildSignInMessage(nonce),
    expiresAt,
  })
})

/** Deterministic synthetic email so wallet users exist in Supabase auth.users. */
function syntheticEmail(stellarAddress: string): string {
  return `${stellarAddress.toLowerCase()}@siws.anielab.app`
}

async function findAuthUserByEmail(email: string) {
  const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) return null
  return data?.users.find((u) => u.email === email) ?? null
}

/**
 * Ensures a Supabase auth user exists for the wallet address, returning its id.
 * The users.id column references auth.users.id, so RLS keyed on auth.uid()
 * works for wallet-authenticated sessions exactly like email sessions.
 */
async function ensureAuthUser(stellarAddress: string, roles?: string[]): Promise<string> {
  const email = syntheticEmail(stellarAddress)
  const existing = await findAuthUserByEmail(email)
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin().auth.admin.createUser({
    email,
    password: randomBytes(24).toString('base64'),
    email_confirm: true,
    user_metadata: {
      stellar_address: stellarAddress,
      auth_method: 'wallet',
      ...(roles && roles.length > 0 ? { roles } : {}),
    },
  })
  if (error && error.code !== 'user_already_exists') {
    throw new Error(`auth user creation failed: ${error.message}`)
  }
  if (data?.user) return data.user.id

  const race = await findAuthUserByEmail(email)
  if (race) return race.id
  throw new Error('could not resolve auth user')
}

/**
 * POST /api/auth/verify — verify a wallet signature and issue a session.
 */
authRouter.post('/verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: 'invalid request' })
  }
  const { stellarAddress, nonce, signature, signedMessage, roles } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return res.status(400).json({ error: 'invalid stellar address' })
  }

  const { data: challenge, error } = await supabaseAdmin()
    .from('auth_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('nonce', nonce)
    .single()

  if (error || !challenge) {
    return res.status(400).json({ error: 'unknown challenge' })
  }
  if (challenge.used_at) {
    return res.status(400).json({ error: 'challenge already used' })
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'challenge expired' })
  }

  if (!verifySignature(stellarAddress, nonce, { signature, signedMessage })) {
    return res.status(401).json({ error: 'signature verification failed' })
  }

  await supabaseAdmin()
    .from('auth_challenges')
    .update({ used_at: new Date().toISOString() })
    .eq('id', challenge.id)

  try {
    const authUserId = await ensureAuthUser(stellarAddress, roles)

    const { data: user, error: userError } = await supabaseAdmin()
      .from('users')
      .upsert(
        {
          id: authUserId,
          stellar_address: stellarAddress,
          auth_method: 'wallet',
        },
        { onConflict: 'id' }
      )
      .select()
      .single()

    if (userError) {
      return res.status(500).json({ error: 'user creation failed' })
    }

    // Exchange the verified signature for a REAL Supabase session: generate a
    // magic-link token for the user's synthetic email, then hand it to the
    // client. `supabase.auth.verifyOtp` swaps it for a proper access + refresh
    // token pair that GoTrue manages and the frontend stores as cookies.
    const email = syntheticEmail(stellarAddress)
    const { data: linkData, error: linkError } = await supabaseAdmin().auth.admin.generateLink({
      type: 'magiclink',
      email,
    })
    if (linkError || !linkData) {
      return res.status(500).json({ error: 'session link generation failed' })
    }

    return res.json({
      verified: true,
      user,
      email,
      tokenHash: linkData.properties.hashed_token,
    })
  } catch (err) {
    console.error('Wallet auth failed:', err)
    return res.status(500).json({ error: 'wallet auth failed' })
  }
})
