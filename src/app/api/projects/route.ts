import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

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
 * Helper: extract and verify the Supabase user from the Authorization header.
 */
async function requireUser(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * GET /api/projects — list projects (public).
 */
export async function GET(req: Request) {
  if (isOptions(req)) return optionsOk()

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return json({ error: 'invalid query' }, 400)
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
    return json({ error: 'projects list failed' }, 500)
  }

  return json({ projects: data })
}

/**
 * POST /api/projects — create a new project (authenticated).
 */
export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
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
      return json({ error: 'could not create user profile' }, 500)
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
    return json({ error: 'project create failed' }, 500)
  }

  return json({ project: data }, 201)
}

/**
 * PATCH /api/projects — update a project (owner only).
 * Body must include `id` (project UUID) and at least one field to update.
 */
export async function PATCH(req: Request) {
  if (isOptions(req)) return optionsOk()

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }

  const projectId = body.id as string | undefined
  if (!projectId) return json({ error: 'missing project id' }, 400)

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
  }

  // Verify ownership.
  const { data: project } = await supabaseAdmin()
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== user.id) {
    return json({ error: 'not the project owner' }, 403)
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
    return json({ error: 'project update failed' }, 500)
  }

  return json({ project: data })
}
