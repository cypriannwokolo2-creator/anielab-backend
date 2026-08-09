import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { deployRevenueSplitter } from '../lib/deployer.js'
import { requireUser } from '../lib/auth.js'

export const projectsRouter = Router()

const querySchema = z.object({
  status: z
    .enum(['draft', 'active', 'funded', 'completed', 'cancelled', 'archived'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  cover_ipfs_cid: z.string().max(500).optional(),
  contract_id: z.string().max(100).optional(),
  funding_goal: z.number().int().min(0).optional(),
})

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  cover_ipfs_cid: z.string().max(500).nullish(),
  status: z
    .enum(['draft', 'active', 'funded', 'completed', 'cancelled', 'archived'])
    .optional(),
  funding_goal: z.number().int().min(0).nullish(),
})

/**
 * GET /api/projects — list projects (public).
 */
projectsRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid query' })
  }
  const { status, limit } = parsed.data

  let query = supabaseAdmin()
    .from('projects')
    .select('*, contributions(*, users(id, display_name, stellar_address))')
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (limit) query = query.limit(limit)

  const { data, error } = await query
  if (error) {
    console.error('projects list failed:', error)
    return res.status(500).json({ error: 'projects list failed' })
  }

  return res.json({ projects: data })
})

/**
 * POST /api/projects — create a new project (authenticated).
 */
projectsRouter.post('/', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  // Ensure the user has a row in the users table.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single()

  if (!userProfile) {
    // Create the user profile row if it doesn't exist yet.
    const stellarAddr =
      user.user_metadata?.stellar_address ||
      user.email?.replace('@siws.anielab.app', '') ||
      user.id
    const { error: insertErr } = await supabaseAdmin().from('users').insert({
      id: user.id,
      stellar_address: stellarAddr,
      display_name: user.user_metadata?.display_name || user.email?.split('@')[0],
    })
    if (insertErr) {
      console.error('user profile insert failed:', insertErr)
      return res.status(500).json({ error: 'could not create user profile' })
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('projects')
    .insert({
      owner_id: user.id,
      title: parsed.data.title,
      description: parsed.data.description,
      cover_ipfs_cid: parsed.data.cover_ipfs_cid,
      contract_id: parsed.data.contract_id,
      funding_goal: parsed.data.funding_goal,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    console.error('project create failed:', error)
    return res.status(500).json({ error: 'project create failed' })
  }

  return res.status(201).json({ project: data })
})

/**
 * PATCH /api/projects — update a project (owner only).
 * Body must include `id` (project UUID) and at least one field to update.
 */
projectsRouter.patch('/', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const body = req.body as Record<string, unknown> | undefined
  const projectId = body?.id as string | undefined
  if (!projectId) return res.status(400).json({ error: 'missing project id' })

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  // Verify ownership.
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return res.status(403).json({ error: 'not the project owner' })
  }

  const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() }

  const { data, error } = await supabaseAdmin()
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single()

  if (error) {
    console.error('project update failed:', error)
    return res.status(500).json({ error: 'project update failed' })
  }

  return res.json({ project: data })
})

const deploySchema = z.object({
  ownerId: z.string().uuid(),
  tokenAddress: z.string().optional(),
  title: z.string().min(1).max(200),
})

/**
 * POST /api/projects/deploy-contract — deploy a fresh per-project
 * RevenueSplitter instance and create the corresponding project row. The
 * owner initializes the contract from the frontend (admin = their wallet,
 * token = project payout token).
 */
projectsRouter.post('/deploy-contract', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const body = deploySchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: 'invalid request' })
  }
  const { ownerId, title } = body.data

  if (user.id !== ownerId) {
    return res.status(403).json({ error: 'owner mismatch' })
  }

  try {
    const contractId = await deployRevenueSplitter()

    const { data: project, error: insertError } = await supabaseAdmin()
      .from('projects')
      .insert({ owner_id: ownerId, title, contract_id: contractId, status: 'draft' })
      .select()
      .single()

    if (insertError) {
      return res.status(500).json({ error: 'project insert failed' })
    }

    return res.json({ project, contractId })
  } catch (err) {
    console.error('Contract deploy failed:', err)
    return res.status(500).json({ error: 'deploy failed' })
  }
})
