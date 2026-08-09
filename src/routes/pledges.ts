import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { requireUser } from '../lib/auth.js'

export const pledgesRouter = Router()

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
pledgesRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'invalid query' })

  let query = supabaseAdmin()
    .from('pledges')
    .select('*, users(id, display_name)')
    .order('created_at', { ascending: false })

  if (parsed.data.project_id) query = query.eq('project_id', parsed.data.project_id)
  if (parsed.data.backer) query = query.eq('backer_address', parsed.data.backer)
  if (parsed.data.limit) query = query.limit(parsed.data.limit)
  else query = query.limit(50)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'failed to fetch pledges' })
  return res.json({ pledges: data })
})

/**
 * POST /api/pledges — record a pledge (authenticated).
 * Called by the frontend after a successful on-chain transfer.
 */
pledgesRouter.post('/', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const parsed = recordSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  // Verify the project exists and is active.
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('id, status')
    .eq('id', parsed.data.project_id)
    .single()

  if (!project) return res.status(404).json({ error: 'project not found' })
  if (project.status !== 'active' && project.status !== 'funded') {
    return res.status(400).json({ error: 'project is not accepting pledges' })
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
    return res.status(500).json({ error: 'failed to record pledge' })
  }

  return res.status(201).json({ pledge: data })
})
