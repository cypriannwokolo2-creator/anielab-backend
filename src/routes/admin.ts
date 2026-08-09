import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { requireAdmin, requireUser } from '../lib/auth.js'
import { hashSecret, verifySecret, randomOtpCode } from '../lib/crypto.js'
import { sendEmail, otpEmailHtml } from '../lib/brevo.js'
import { issueAdminToken, verifyAdminToken } from '../lib/adminSession.js'

export const adminRouter = Router()

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_COOLDOWN_MS = 60 * 1000

const settingsSchema = z.object({
  platform_fee_bps: z.number().int().min(0).max(2000).optional(),
  platform_wallet: z.string().max(60).optional(),
})

// Enforce a minimum of real password strength.
const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .regex(/[a-zA-Z]/, 'password must contain a letter')
  .regex(/[0-9#?!@%^&*_-]/, 'password must contain a digit or symbol')

function maskEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!domain) return email
  return `${name.slice(0, 2)}***@${domain}`
}

/** Issue a fresh OTP for the admin user, store its hash, and email it. */
async function issueOtp(userId: string, email: string): Promise<void> {
  const code = randomOtpCode()
  const codeHash = await hashSecret(code)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString()

  const { error } = await supabaseAdmin().from('admin_otp').upsert({
    user_id: userId,
    code_hash: codeHash,
    expires_at: expiresAt,
    attempts: 0,
    last_sent_at: now.toISOString(),
  })
  if (error) throw new Error(`failed to store otp: ${error.message}`)

  await sendEmail({
    to: email,
    subject: 'Your AnieLab admin verification code',
    html: otpEmailHtml(code),
  })
}

/**
 * POST /api/admin/auth — step 1: verify the panel password.
 * Body: { password: string }
 *
 * Requires a valid Supabase session. On success, emails a 6-digit OTP to the
 * admin's address and returns { otp_required: true }. The panel password is
 * stored hashed (scrypt) in admin_credentials — never plaintext.
 */
adminRouter.post('/auth', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'sign in required' })

  const body = req.body as { password?: string } | undefined
  if (!body?.password || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'password is required' })
  }

  const { data: cred, error } = await supabaseAdmin()
    .from('admin_credentials')
    .select('password_hash, email')
    .eq('user_id', user.id)
    .single()

  if (error || !cred) return res.status(403).json({ error: 'not an admin account' })

  const ok = await verifySecret(body.password, cred.password_hash as string)
  if (!ok) return res.status(403).json({ error: 'invalid admin password' })

  const email = (cred.email as string) || user.email || ''
  if (!email) return res.status(500).json({ error: 'admin account has no email' })

  try {
    await issueOtp(user.id, email)
  } catch (err) {
    console.error('Admin OTP issue failed:', err)
    return res.status(500).json({ error: 'failed to send verification email' })
  }

  return res.json({ otp_required: true, email: maskEmail(email) })
})

/**
 * POST /api/admin/otp/verify — step 2: verify the emailed code.
 * Body: { code: string }
 *
 * On success returns a signed admin session token (12h TTL) that the
 * frontend sends on X-Admin-Token for privileged calls.
 */
adminRouter.post('/otp/verify', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'sign in required' })

  const body = req.body as { code?: string } | undefined
  if (!body?.code || typeof body.code !== 'string') {
    return res.status(400).json({ error: 'code is required' })
  }

  const { data: otp, error } = await supabaseAdmin()
    .from('admin_otp')
    .select('*')
    .eq('user_id', user.id)
    .single()

  if (error || !otp) return res.status(403).json({ error: 'no pending code — sign in again' })

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return res.status(403).json({ error: 'code expired — sign in again' })
  }
  if ((otp.attempts as number) >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too many attempts — sign in again' })
  }

  const ok = await verifySecret(body.code.trim(), otp.code_hash as string)
  if (!ok) {
    await supabaseAdmin()
      .from('admin_otp')
      .update({ attempts: (otp.attempts as number) + 1 })
      .eq('user_id', user.id)
    return res.status(403).json({ error: 'invalid code' })
  }

  // Single-use: consume the code, then grant the session token.
  await supabaseAdmin().from('admin_otp').delete().eq('user_id', user.id)
  const token = issueAdminToken(user.id, user.email ?? '')
  return res.json({ token })
})

/** POST /api/admin/otp/resend — re-send the code (60s cooldown). */
adminRouter.post('/otp/resend', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'sign in required' })

  const { data: otp } = await supabaseAdmin()
    .from('admin_otp')
    .select('last_sent_at')
    .eq('user_id', user.id)
    .single()

  if (!otp) return res.status(403).json({ error: 'no pending code — sign in again' })

  const lastSent = otp.last_sent_at ? new Date(otp.last_sent_at).getTime() : 0
  if (Date.now() - lastSent < OTP_RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: 'wait a minute before resending' })
  }

  const email = user.email ?? ''
  if (!email) return res.status(500).json({ error: 'admin account has no email' })

  try {
    await issueOtp(user.id, email)
  } catch (err) {
    console.error('Admin OTP resend failed:', err)
    return res.status(500).json({ error: 'failed to send verification email' })
  }
  return res.json({ sent: true })
})

/** GET /api/admin/session — validate an admin token (used by the web guard). */
adminRouter.get('/session', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'sign in required' })

  const token = req.headers['x-admin-token']
  const payload = verifyAdminToken(typeof token === 'string' ? token : null)
  if (!payload || payload.sub !== user.id) {
    return res.status(403).json({ error: 'admin session invalid' })
  }
  return res.json({ valid: true, expires_at: new Date(payload.exp * 1000).toISOString() })
})

/**
 * PATCH /api/admin/password — change the panel password.
 * Body: { current_password: string, new_password: string }
 *
 * Updates the hashed password in admin_credentials AND the Supabase auth
 * user's password, so email sign-in stays in sync.
 */
adminRouter.patch('/password', async (req, res) => {
  const admin = await requireAdmin(req)
  if (!admin) return res.status(403).json({ error: 'admin auth required' })

  const body = req.body as { current_password?: string; new_password?: string } | undefined
  if (!body?.current_password || !body?.new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' })
  }

  const parsed = passwordSchema.safeParse(body.new_password)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'weak password' })
  }

  const { data: cred, error } = await supabaseAdmin()
    .from('admin_credentials')
    .select('password_hash')
    .eq('user_id', admin.id)
    .single()

  if (error || !cred) return res.status(403).json({ error: 'not an admin account' })

  const ok = await verifySecret(body.current_password, cred.password_hash as string)
  if (!ok) return res.status(403).json({ error: 'current password is incorrect' })

  const newHash = await hashSecret(body.new_password)
  const { error: updateErr } = await supabaseAdmin()
    .from('admin_credentials')
    .update({ password_hash: newHash, updated_at: new Date().toISOString() })
    .eq('user_id', admin.id)
  if (updateErr) return res.status(500).json({ error: 'failed to update password' })

  // Keep Supabase email/password sign-in in sync.
  const { error: authErr } = await supabaseAdmin().auth.admin.updateUserById(admin.id, {
    password: body.new_password,
  })
  if (authErr) {
    console.error('Supabase password sync failed:', authErr.message)
  }

  return res.json({ updated: true })
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
 * Requires X-Admin-Token header + valid Supabase session.
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
