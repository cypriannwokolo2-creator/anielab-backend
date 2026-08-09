import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config.js'

let admin: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return admin
}
