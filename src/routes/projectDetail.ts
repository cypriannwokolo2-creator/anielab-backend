import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { requireUser } from '../lib/auth.js'

/**
 * Router for /api/projects/:id/* — milestones, release, cancel, contributors.
 */
export const projectDetailRouter = Router({ mergeParams: true })

async function requireProjectOwner(projectId: string, userId: string) {
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()
  return project?.owner_id === userId
}

const milestoneSchema = z.object({
  title: z.string().min(1).max(200),
  pct_bps: z.number().int().min(1).max(10000),
})
const setMilestonesSchema = z.object({
  milestones: z.array(milestoneSchema).min(1).max(20),
})

/**
 * GET /api/projects/:id/milestones — list milestones for a project.
 */
projectDetailRouter.get('/milestones', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const { data, error } = await supabaseAdmin()
    .from('milestones')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order')

  if (error) return res.status(500).json({ error: 'failed to fetch milestones' })
  return res.json({ milestones: data })
})

/**
 * POST /api/projects/:id/milestones — set milestones (owner only).
 * Replaces all milestones. Validates that percentages sum to 10000 (100%).
 */
projectDetailRouter.post('/milestones', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  // Verify ownership.
  if (!(await requireProjectOwner(projectId, user.id))) {
    return res.status(403).json({ error: 'not the project owner' })
  }

  const parsed = setMilestonesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  // Validate total percentages = 10000 bps (100%).
  const totalBps = parsed.data.milestones.reduce((s, m) => s + m.pct_bps, 0)
  if (totalBps !== 10000) {
    return res
      .status(400)
      .json({ error: `milestone percentages must sum to 10000 (100%), got ${totalBps}` })
  }

  // Check no milestones already released.
  const { data: existing } = await supabaseAdmin()
    .from('milestones')
    .select('released')
    .eq('project_id', projectId)
    .eq('released', true)

  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'cannot change milestones after a release' })
  }

  // Delete existing milestones and insert new ones.
  await supabaseAdmin().from('milestones').delete().eq('project_id', projectId)

  const rows = parsed.data.milestones.map((m, i) => ({
    project_id: projectId,
    title: m.title,
    pct_bps: m.pct_bps,
    sort_order: i,
  }))

  const { data, error } = await supabaseAdmin()
    .from('milestones')
    .insert(rows)
    .select()

  if (error) return res.status(500).json({ error: 'failed to save milestones' })

  // Update project milestone count.
  await supabaseAdmin()
    .from('projects')
    .update({ milestone_count: rows.length, updated_at: new Date().toISOString() })
    .eq('id', projectId)

  return res.status(201).json({ milestones: data })
})

/**
 * POST /api/projects/:id/release — release the next milestone.
 *
 * In production this triggers the on-chain `release_next_milestone` call
 * and then marks the milestone as released in the DB. For now, it performs
 * the DB-only update (on-chain integration is wired separately via the
 * deploy-contract flow).
 *
 * Owner-only.
 */
projectDetailRouter.post('/release', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id, status')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return res.status(403).json({ error: 'not the project owner' })
  }
  if (project.status === 'cancelled') {
    return res.status(400).json({ error: 'project is cancelled' })
  }

  // Find the next unreleased milestone.
  const { data: milestones } = await supabaseAdmin()
    .from('milestones')
    .select('*')
    .eq('project_id', projectId)
    .eq('released', false)
    .order('sort_order')
    .limit(1)

  if (!milestones || milestones.length === 0) {
    return res.status(400).json({ error: 'all milestones already released' })
  }

  const milestone = milestones[0]

  // Mark as released.
  const { error } = await supabaseAdmin()
    .from('milestones')
    .update({ released: true, released_at: new Date().toISOString() })
    .eq('id', milestone.id)

  if (error) return res.status(500).json({ error: 'failed to update milestone' })

  return res.json({
    released: {
      id: milestone.id,
      title: milestone.title,
      pct_bps: milestone.pct_bps,
      released_at: new Date().toISOString(),
    },
  })
})

/**
 * POST /api/projects/:id/cancel — cancel a project and mark for refund.
 * Owner-only. Sets status to 'cancelled' in the DB.
 * On-chain cancel is handled separately.
 */
projectDetailRouter.post('/cancel', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id, status')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return res.status(403).json({ error: 'not the project owner' })
  }
  if (project.status === 'cancelled') {
    return res.status(400).json({ error: 'already cancelled' })
  }
  if (project.status === 'completed') {
    return res.status(400).json({ error: 'cannot cancel a completed project' })
  }

  const { data, error } = await supabaseAdmin()
    .from('projects')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .select()
    .single()

  if (error) return res.status(500).json({ error: 'failed to cancel project' })
  return res.json({ project: data })
})

const contributorSchema = z.object({
  user_id: z.string().uuid().optional(),
  stellar_address: z.string().max(60).optional(),
  role: z.string().min(1).max(100),
  share_pct: z.number().min(0.01).max(100),
})

/**
 * GET /api/projects/:id/contributors — list contributors for a project.
 */
projectDetailRouter.get('/contributors', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const { data, error } = await supabaseAdmin()
    .from('contributions')
    .select('*, users(id, display_name, stellar_address)')
    .eq('project_id', projectId)
    .order('created_at')

  if (error) return res.status(500).json({ error: 'failed to fetch contributors' })
  return res.json({ contributions: data })
})

/**
 * POST /api/projects/:id/contributors — add a contributor (owner only).
 */
projectDetailRouter.post('/contributors', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })
  if (!(await requireProjectOwner(projectId, user.id))) {
    return res.status(403).json({ error: 'not the project owner' })
  }

  const parsed = contributorSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  // Resolve user_id from stellar_address if not provided.
  let resolvedUserId = parsed.data.user_id
  if (!resolvedUserId && parsed.data.stellar_address) {
    const { data: u } = await supabaseAdmin()
      .from('users')
      .select('id')
      .eq('stellar_address', parsed.data.stellar_address)
      .single()
    resolvedUserId = u?.id
  }

  if (!resolvedUserId) {
    return res
      .status(400)
      .json({ error: 'could not resolve user (provide user_id or valid stellar_address)' })
  }

  const { data, error } = await supabaseAdmin()
    .from('contributions')
    .insert({
      project_id: projectId,
      user_id: resolvedUserId,
      role: parsed.data.role,
      share_pct: parsed.data.share_pct,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'user is already a contributor' })
    }
    return res.status(500).json({ error: 'failed to add contributor' })
  }

  return res.status(201).json({ contribution: data })
})

/**
 * DELETE /api/projects/:id/contributors — remove a contributor (owner only).
 * Body: { contribution_id: string }
 */
projectDetailRouter.delete('/contributors', async (req, res) => {
  const projectId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })
  if (!(await requireProjectOwner(projectId, user.id))) {
    return res.status(403).json({ error: 'not the project owner' })
  }

  const body = req.body as { contribution_id?: string } | undefined
  if (!body?.contribution_id) return res.status(400).json({ error: 'missing contribution_id' })

  const { error } = await supabaseAdmin()
    .from('contributions')
    .delete()
    .eq('id', body.contribution_id)
    .eq('project_id', projectId)

  if (error) return res.status(500).json({ error: 'failed to remove contributor' })
  return res.json({ ok: true })
})
