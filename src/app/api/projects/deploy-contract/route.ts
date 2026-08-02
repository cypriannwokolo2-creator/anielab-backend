import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { deployRevenueSplitter } from '@/lib/stellar/deployer'
import { json, isOptions, optionsOk } from '@/lib/http'

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
  if (isOptions(req)) return optionsOk()

  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) {
    return json({ error: 'missing authorization' }, 401)
  }
  const { data: { user }, error: authError } = await supabaseAdmin().auth.getUser(auth)
  if (authError || !user) {
    return json({ error: 'unauthorized' }, 401)
  }

  const body = schema.safeParse(await req.json())
  if (!body.success) {
    return json({ error: 'invalid request' }, 400)
  }
  const { ownerId, title } = body.data

  if (user.id !== ownerId) {
    return json({ error: 'owner mismatch' }, 403)
  }

  try {
    const contractId = await deployRevenueSplitter()

    const { data: project, error: insertError } = await supabaseAdmin()
      .from('projects')
      .insert({ owner_id: ownerId, title, contract_id: contractId, status: 'draft' })
      .select()
      .single()

    if (insertError) {
      return json({ error: 'project insert failed' }, 500)
    }

    return json({ project, contractId })
  } catch (err) {
    console.error('Contract deploy failed:', err)
    return json({ error: 'deploy failed' }, 500)
  }
}
