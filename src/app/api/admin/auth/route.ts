import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

/**
 * POST /api/admin/auth — verify admin password.
 * Returns a simple token/session indicator for admin access.
 * Body: { password: string }
 *
 * This is a lightweight admin gate on top of the Supabase session.
 * The frontend stores the password in sessionStorage and sends it
 * with x-admin-password on admin API calls.
 */
export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const expected = process.env.ADMIN_PASSWORD
  if (!expected) {
    return json({ error: 'ADMIN_PASSWORD not configured' }, 500)
  }

  let body: { password?: string }
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  if (!body.password || body.password !== expected) {
    return json({ error: 'invalid admin password' }, 403)
  }

  return json({ admin: true })
}
