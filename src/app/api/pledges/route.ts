import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const recordSchema = z.object({
  project_id: z.string().uuid(),
  amount: z.number().int().positive(),
  fee: z.number().int().min(0).default(0),
  currency: z.string().max(10).default('USDC'),
  tx_hash: z.string().max(100).optional(),
})

const querySchema = z.object({
  project_id: z.string().uuid().optional(),
  backer: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * GET /api/pledges — list pledges (public).
 * Optional filters: project_id, backer (stellar address), limit.
 */
export async function GET(req: Request) {
  if (isOptions(req)) return optionsOk()

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({
    project_id: url.searchParams.get('project_id') ?? undefined,
    backer: url.searchParams.get('backer') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) return json({ error: 'invalid query' }, 400)

  let query = supabaseAdmin()
    .from('pledges')
    .select('*, users(id, display_name)')
    .order('created_at', { ascending: false })

  if (parsed.data.project_id) query = query.eq('project_id', parsed.data.project_id)
  if (parsed.data.backer) query = query.eq('backer_address', parsed.data.backer)
  if (parsed.data.limit) query = query.limit(parsed.data.limit)
  else query = query.limit(50)

  const { data, error } = await query
  if (error) return json({ error: 'failed to fetch pledges' }, 500)
  return json({ pledges: data })
}

/**
 * POST /api/pledges — record a pledge (authenticated).
 * Called by the frontend after a successful on-chain transfer.
 */
export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return json({ error: 'unauthorized' }, 401)

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = recordSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
  }

  // Verify the project exists and is active.
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('id, status')
    .eq('id', parsed.data.project_id)
    .single()

  if (!project) return json({ error: 'project not found' }, 404)
  if (project.status !== 'active' && project.status !== 'funded') {
    return json({ error: 'project is not accepting pledges' }, 400)
  }

  // Look up user profile to link user_id.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id, stellar_address')
    .eq('id', user.id)
    .single()

  const backerAddress = userProfile?.stellar_address || user.id

  const { data, error: insertError } = await supabaseAdmin()
    .from('pledges')
    .insert({
      project_id: parsed.data.project_id,
      backer_address: backerAddress,
      user_id: user.id,
      amount: parsed.data.amount,
      fee: parsed.data.fee,
      currency: parsed.data.currency,
      tx_hash: parsed.data.tx_hash,
    })
    .select()
    .single()

  if (insertError) {
    console.error('pledge insert failed:', insertError)
    return json({ error: 'failed to record pledge' }, 500)
  }

  return json({ pledge: data }, 201)
}
