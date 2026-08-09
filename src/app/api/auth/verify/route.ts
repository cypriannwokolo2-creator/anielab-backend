import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { verifySignature } from '@/lib/stellar/siws'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const schema = z.object({
  stellarAddress: z.string(),
  nonce: z.string(),
  signature: z.string().optional(),
  signedMessage: z.string().optional(),
  roles: z.array(z.string().max(40)).max(3).optional(),
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

export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return json({ error: 'invalid request' }, 400)
  }
  const { stellarAddress, nonce, signature, signedMessage, roles } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return json({ error: 'invalid stellar address' }, 400)
  }

  const { data: challenge, error } = await supabaseAdmin()
    .from('auth_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('nonce', nonce)
    .single()

  if (error || !challenge) {
    return json({ error: 'unknown challenge' }, 400)
  }
  if (challenge.used_at) {
    return json({ error: 'challenge already used' }, 400)
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return json({ error: 'challenge expired' }, 400)
  }

  if (!verifySignature(stellarAddress, nonce, { signature, signedMessage })) {
    return json({ error: 'signature verification failed' }, 401)
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
      return json({ error: 'user creation failed' }, 500)
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
      return json({ error: 'session link generation failed' }, 500)
    }

    return json({
      verified: true,
      user,
      email,
      tokenHash: linkData.properties.hashed_token,
    })
  } catch (err) {
    console.error('Wallet auth failed:', err)
    return json({ error: 'wallet auth failed' }, 500)
  }
}
