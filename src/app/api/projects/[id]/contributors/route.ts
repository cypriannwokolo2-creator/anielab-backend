import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const addSchema = z.object({
  user_id: z.string().uuid().optional(),
  stellar_address: z.string().max(60).optional(),
  role: z.string().min(1).max(100),
  share_pct: z.number().min(0.01).max(100),
})

async function requireUser(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

async function requireProjectOwner(projectId: string, userId: string) {
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()
  return project?.owner_id === userId
}

/**
 * GET /api/projects/[id]/contributors — list contributors for a project.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id } = await params

  const { data, error } = await supabaseAdmin()
    .from('contributions')
    .select('*, users(id, display_name, stellar_address)')
    .eq('project_id', id)
    .order('created_at')

  if (error) return json({ error: 'failed to fetch contributors' }, 500)
  return json({ contributions: data })
}

/**
 * POST /api/projects/[id]/contributors — add a contributor (owner only).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: projectId } = await params

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)
  if (!(await requireProjectOwner(projectId, user.id))) {
    return json({ error: 'not the project owner' }, 403)
  }

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = addSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
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
    return json({ error: 'could not resolve user (provide user_id or valid stellar_address)' }, 400)
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
      return json({ error: 'user is already a contributor' }, 409)
    }
    return json({ error: 'failed to add contributor' }, 500)
  }

  return json({ contribution: data }, 201)
}

/**
 * DELETE /api/projects/[id]/contributors — remove a contributor (owner only).
 * Body: { contribution_id: string }
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: projectId } = await params

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)
  if (!(await requireProjectOwner(projectId, user.id))) {
    return json({ error: 'not the project owner' }, 403)
  }

  let body: { contribution_id?: string }
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }
  if (!body.contribution_id) return json({ error: 'missing contribution_id' }, 400)

  const { error } = await supabaseAdmin()
    .from('contributions')
    .delete()
    .eq('id', body.contribution_id)
    .eq('project_id', projectId)

  if (error) return json({ error: 'failed to remove contributor' }, 500)
  return json({ ok: true })
}
