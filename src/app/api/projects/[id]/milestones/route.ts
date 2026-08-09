import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const milestoneSchema = z.object({
  title: z.string().min(1).max(200),
  pct_bps: z.number().int().min(1).max(10000),
})
const setMilestonesSchema = z.object({
  milestones: z.array(milestoneSchema).min(1).max(20),
})

async function requireUser(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * GET /api/projects/[id]/milestones — list milestones for a project.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id } = await params

  const { data, error } = await supabaseAdmin()
    .from('milestones')
    .select('*')
    .eq('project_id', id)
    .order('sort_order')

  if (error) return json({ error: 'failed to fetch milestones' }, 500)
  return json({ milestones: data })
}

/**
 * POST /api/projects/[id]/milestones — set milestones (owner only).
 * Replaces all milestones. Validates that percentages sum to 10000 (100%).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: projectId } = await params

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  // Verify ownership.
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return json({ error: 'not the project owner' }, 403)
  }

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = setMilestonesSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
  }

  // Validate total percentages = 10000 bps (100%).
  const totalBps = parsed.data.milestones.reduce((s, m) => s + m.pct_bps, 0)
  if (totalBps !== 10000) {
    return json({ error: `milestone percentages must sum to 10000 (100%), got ${totalBps}` }, 400)
  }

  // Check no milestones already released.
  const { data: existing } = await supabaseAdmin()
    .from('milestones')
    .select('released')
    .eq('project_id', projectId)
    .eq('released', true)

  if (existing && existing.length > 0) {
    return json({ error: 'cannot change milestones after a release' }, 409)
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

  if (error) return json({ error: 'failed to save milestones' }, 500)

  // Update project milestone count.
  await supabaseAdmin()
    .from('projects')
    .update({ milestone_count: rows.length, updated_at: new Date().toISOString() })
    .eq('id', projectId)

  return json({ milestones: data }, 201)
}
