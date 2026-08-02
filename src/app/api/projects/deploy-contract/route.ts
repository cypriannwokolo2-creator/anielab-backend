import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { deployRevenueSplitter } from '@/lib/stellar/deployer'

export const runtime = 'nodejs'
export const maxDuration = 60

const schema = z.object({
  ownerId: z.string().uuid(),
  tokenAddress: z.string().optional(),
  title: z.string().min(1).max(200),
})

/**
 * Deploys a fresh per-project RevenueSplitter instance and creates the
 * corresponding project row. The owner initializes the contract from the
 * frontend (admin = their wallet, token = project payout token).
 */
export async function POST(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) {
    return NextResponse.json({ error: 'missing authorization' }, { status: 401 })
  }
  const { data: { user }, error: authError } = await supabaseAdmin().auth.getUser(auth)
  if (authError || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const { ownerId, title } = body.data

  if (user.id !== ownerId) {
    return NextResponse.json({ error: 'owner mismatch' }, { status: 403 })
  }

  try {
    const contractId = await deployRevenueSplitter()

    const { data: project, error: insertError } = await supabaseAdmin()
      .from('projects')
      .insert({ owner_id: ownerId, title, contract_id: contractId, status: 'draft' })
      .select()
      .single()

    if (insertError) {
      return NextResponse.json({ error: 'project insert failed' }, { status: 500 })
    }

    return NextResponse.json({ project, contractId })
  } catch (err) {
    console.error('Contract deploy failed:', err)
    return NextResponse.json({ error: 'deploy failed' }, { status: 500 })
  }
}
