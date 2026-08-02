import { createClient, SupabaseClient } from '@supabase/supabase-js'

let admin: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  }
  return admin
}
