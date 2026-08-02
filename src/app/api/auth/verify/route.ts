import { NextResponse } from 'next/server'
import { z } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { verifySignature } from '@/lib/stellar/siws'

export const runtime = 'nodejs'

const schema = z.object({
  stellarAddress: z.string(),
  nonce: z.string(),
  signature: z.string(),
})

export async function POST(req: Request) {
  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const { stellarAddress, nonce, signature } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return NextResponse.json({ error: 'invalid stellar address' }, { status: 400 })
  }

  const { data: challenge, error } = await supabaseAdmin()
    .from('auth_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('nonce', nonce)
    .single()

  if (error || !challenge) {
    return NextResponse.json({ error: 'unknown challenge' }, { status: 400 })
  }
  if (challenge.used_at) {
    return NextResponse.json({ error: 'challenge already used' }, { status: 400 })
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'challenge expired' }, { status: 400 })
  }

  if (!verifySignature(stellarAddress, nonce, signature)) {
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 })
  }

  await supabaseAdmin()
    .from('auth_challenges')
    .update({ used_at: new Date().toISOString() })
    .eq('id', challenge.id)

  const { data: user, error: userError } = await supabaseAdmin()
    .from('users')
    .upsert(
      { stellar_address: stellarAddress },
      { onConflict: 'stellar_address', ignoreDuplicates: true }
    )
    .select()
    .single()

  if (userError) {
    return NextResponse.json({ error: 'user creation failed' }, { status: 500 })
  }

  return NextResponse.json({ verified: true, user })
}
