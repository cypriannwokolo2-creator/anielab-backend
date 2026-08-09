import type { Request } from 'express'
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from './supabaseAdmin.js'
import { config } from '../config.js'

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
 * Admin gate: x-admin-password header + a valid Supabase session.
 * Returns null when either check fails.
 */
export async function requireAdmin(req: Request): Promise<User | null> {
  if (!config.adminPassword) return null
  const password = req.headers['x-admin-password']
  if (typeof password !== 'string' || password !== config.adminPassword) return null
  return requireUser(req)
}
