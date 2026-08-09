import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  theme: z.string().max(200).optional(),
  prize_pool: z.number().int().min(0).default(0),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  cover_image_key: z.string().max(500).optional(),
})

const querySchema = z.object({
  status: z.enum(['upcoming', 'active', 'judging', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

async function requireAdmin(req: Request) {
  const password = req.headers.get('x-admin-password')
  if (!password || password !== process.env.ADMIN_PASSWORD) return null

  // Also verify a valid Supabase session.
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * GET /api/challenges — list challenges (public).
 */
export async function GET(req: Request) {
  if (isOptions(req)) return optionsOk()

  const url = new URL(req.url)
  const parsed = querySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) return json({ error: 'invalid query' }, 400)

  let query = supabaseAdmin()
    .from('challenges')
    .select('*, users(id, display_name)')
    .order('starts_at', { ascending: false })

  if (parsed.data.status) query = query.eq('status', parsed.data.status)
  if (parsed.data.limit) query = query.limit(parsed.data.limit)

  const { data, error } = await query
  if (error) return json({ error: 'failed to fetch challenges' }, 500)
  return json({ challenges: data })
}

/**
 * POST /api/challenges — create a challenge (admin only).
 * Requires x-admin-password header + valid Supabase session.
 */
export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const admin = await requireAdmin(req)
  if (!admin) return json({ error: 'admin auth required' }, 403)

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
  }

  if (new Date(parsed.data.ends_at) <= new Date(parsed.data.starts_at)) {
    return json({ error: 'ends_at must be after starts_at' }, 400)
  }

  // Ensure user has a profile row.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('id', admin.id)
    .single()

  if (!userProfile) {
    return json({ error: 'user profile not found' }, 400)
  }

  const { data, error } = await supabaseAdmin()
    .from('challenges')
    .insert({
      title: parsed.data.title,
      description: parsed.data.description,
      theme: parsed.data.theme,
      prize_pool: parsed.data.prize_pool,
      starts_at: parsed.data.starts_at,
      ends_at: parsed.data.ends_at,
      cover_image_key: parsed.data.cover_image_key,
      created_by: admin.id,
    })
    .select()
    .single()

  if (error) {
    console.error('challenge create failed:', error)
    return json({ error: 'failed to create challenge' }, 500)
  }

  return json({ challenge: data }, 201)
}
