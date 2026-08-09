import type { Request } from 'express'
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from './supabaseAdmin.js'
import { verifyAdminToken } from './adminSession.js'

/**
 * Extract and verify the Supabase user from the Authorization header.
 * Returns null when the request is not authenticated.
 */
export async function requireUser(req: Request): Promise<User | null> {
  const auth = req.headers.authorization?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * Admin gate: a valid Supabase session + a signed admin session token
 * (X-Admin-Token header) issued after the password + OTP check.
 * Returns null when either check fails.
 */
export async function requireAdmin(req: Request): Promise<User | null> {
  const user = await requireUser(req)
  if (!user) return null
  const token = req.headers['x-admin-token']
  const payload = verifyAdminToken(typeof token === 'string' ? token : null)
  if (!payload || payload.sub !== user.id) return null
  return user
}
