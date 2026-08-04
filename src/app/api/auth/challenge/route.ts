import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { buildSignInMessage } from '@/lib/stellar/siws'
import { rateLimit } from '@/lib/rateLimit'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const schema = z.object({
  stellarAddress: z.string(),
})

export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return json({ error: 'invalid request' }, 400)
  }
  const { stellarAddress } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return json({ error: 'invalid stellar address' }, 400)
  }

  // Don't let one address mint unlimited nonces — an attacker could otherwise
  // fill auth_challenges and spam the sign-in flow.
  if (!rateLimit(`challenge:${stellarAddress}`)) {
    return json({ error: 'too many challenge requests, slow down' }, 429)
  }

  const nonce = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { error } = await supabaseAdmin()
    .from('auth_challenges')
    .insert({ stellar_address: stellarAddress, nonce, expires_at: expiresAt })

  if (error) {
    return json({ error: 'challenge creation failed' }, 500)
  }

  return json({
    nonce,
    message: buildSignInMessage(nonce),
    expiresAt,
  })
}
