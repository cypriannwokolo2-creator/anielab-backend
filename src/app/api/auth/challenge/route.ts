import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { buildSignInMessage } from '@/lib/stellar/siws'

export const runtime = 'nodejs'

const schema = z.object({
  stellarAddress: z.string(),
})

export async function POST(req: Request) {
  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const { stellarAddress } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return NextResponse.json({ error: 'invalid stellar address' }, { status: 400 })
  }

  const nonce = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { error } = await supabaseAdmin()
    .from('auth_challenges')
    .insert({ stellar_address: stellarAddress, nonce, expires_at: expiresAt })

  if (error) {
    return NextResponse.json({ error: 'challenge creation failed' }, { status: 500 })
  }

  return NextResponse.json({
    nonce,
    message: buildSignInMessage(nonce),
    expiresAt,
  })
}
