import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

async function requireUser(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * POST /api/projects/[id]/release — release the next milestone.
 *
 * In production this triggers the on-chain `release_next_milestone` call
 * and then marks the milestone as released in the DB. For now, it performs
 * the DB-only update (on-chain integration is wired separately via the
 * deploy-contract flow).
 *
 * Owner-only.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: projectId } = await params

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id, status')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return json({ error: 'not the project owner' }, 403)
  }
  if (project.status === 'cancelled') {
    return json({ error: 'project is cancelled' }, 400)
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
    return json({ error: 'all milestones already released' }, 400)
  }

  const milestone = milestones[0]

  // Mark as released.
  const { error } = await supabaseAdmin()
    .from('milestones')
    .update({ released: true, released_at: new Date().toISOString() })
    .eq('id', milestone.id)

  if (error) return json({ error: 'failed to update milestone' }, 500)

  return json({
    released: {
      id: milestone.id,
      title: milestone.title,
      pct_bps: milestone.pct_bps,
      released_at: new Date().toISOString(),
    },
  })
}
