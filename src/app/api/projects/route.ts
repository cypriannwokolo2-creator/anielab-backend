import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const querySchema = z.object({
  status: z.enum(['draft', 'active', 'funded', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

/**
 * Public read endpoint: lists projects (optionally filtered by status).
 * Mirrors what the frontend reads via RLS, but usable by any client that
 * only has the backend URL.
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

  let query = supabaseAdmin().from('projects').select('*').order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (limit) query = query.limit(limit)

  const { data, error } = await query
  if (error) {
    console.error('projects list failed:', error)
    return json({ error: 'projects list failed' }, 500)
  }

  return json({ projects: data })
}
