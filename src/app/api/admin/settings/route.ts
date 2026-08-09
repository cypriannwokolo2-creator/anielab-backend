import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const updateSchema = z.object({
  platform_fee_bps: z.number().int().min(0).max(2000).optional(),
  platform_wallet: z.string().max(60).optional(),
})

async function requireAdmin(req: Request) {
  const password = req.headers.get('x-admin-password')
  if (!password || password !== process.env.ADMIN_PASSWORD) return null
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * GET /api/admin/settings — read platform settings (public).
 */
export async function GET(req: Request) {
  if (isOptions(req)) return optionsOk()

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select('*')
    .eq('id', 1)
    .single()

  if (error) return json({ error: 'failed to fetch settings' }, 500)
  return json({ settings: data })
}

/**
 * PATCH /api/admin/settings — update platform settings (admin only).
 * Requires x-admin-password header + valid Supabase session.
 */
export async function PATCH(req: Request) {
  if (isOptions(req)) return optionsOk()

  const admin = await requireAdmin(req)
  if (!admin) return json({ error: 'admin auth required' }, 403)

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
  }

  const updates: Record<string, unknown> = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .update(updates)
    .eq('id', 1)
    .select()
    .single()

  if (error) return json({ error: 'failed to update settings' }, 500)
  return json({ settings: data })
}
