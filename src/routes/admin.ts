import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { requireAdmin } from '../lib/auth.js'
import { config } from '../config.js'

export const adminRouter = Router()

const settingsSchema = z.object({
  platform_fee_bps: z.number().int().min(0).max(2000).optional(),
  platform_wallet: z.string().max(60).optional(),
})

/**
 * POST /api/admin/auth — verify admin password.
 * Body: { password: string }
 *
 * This is a lightweight admin gate on top of the Supabase session.
 * The frontend stores the password in sessionStorage and sends it
 * with x-admin-password on admin API calls.
 */
adminRouter.post('/auth', async (req, res) => {
  const expected = config.adminPassword
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' })
  }

  const body = req.body as { password?: string } | undefined
  if (!body?.password || body.password !== expected) {
    return res.status(403).json({ error: 'invalid admin password' })
  }

  return res.json({ admin: true })
})

/**
 * GET /api/admin/settings — read platform settings (public).
 */
adminRouter.get('/settings', async (_req, res) => {
  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select('*')
    .eq('id', 1)
    .single()

  if (error) return res.status(500).json({ error: 'failed to fetch settings' })
  return res.json({ settings: data })
})

/**
 * PATCH /api/admin/settings — update platform settings (admin only).
 * Requires x-admin-password header + valid Supabase session.
 */
adminRouter.patch('/settings', async (req, res) => {
  const admin = await requireAdmin(req)
  if (!admin) return res.status(403).json({ error: 'admin auth required' })

  const parsed = settingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
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

  if (error) return res.status(500).json({ error: 'failed to update settings' })
  return res.json({ settings: data })
})
