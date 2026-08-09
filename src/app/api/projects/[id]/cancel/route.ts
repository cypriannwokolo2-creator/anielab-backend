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
 * POST /api/projects/[id]/cancel — cancel a project and mark for refund.
 * Owner-only. Sets status to 'cancelled' in the DB.
 * On-chain cancel is handled separately.
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
    return json({ error: 'already cancelled' }, 400)
  }
  if (project.status === 'completed') {
    return json({ error: 'cannot cancel a completed project' }, 400)
  }

  const { data, error } = await supabaseAdmin()
    .from('projects')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .select()
    .single()

  if (error) return json({ error: 'failed to cancel project' }, 500)
  return json({ project: data })
}
