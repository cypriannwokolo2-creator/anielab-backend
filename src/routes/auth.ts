import { Router } from 'express'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { buildSignInMessage, verifySignature } from '../lib/siws.js'
import { rateLimit } from '../lib/rateLimit.js'
import { hashSecret, verifySecret, randomOtpCode } from '../lib/crypto.js'
import { sendEmail, otpEmailHtml, signupSuccessEmailHtml } from '../lib/brevo.js'

export const authRouter = Router()

const SIGNUP_OTP_TTL_MS = 5 * 60 * 1000
const SIGNUP_OTP_MAX_ATTEMPTS = 5
const SIGNUP_OTP_RESEND_COOLDOWN_MS = 60 * 1000

// Roles are informational profile tags picked from a fixed allow-list.
// Free-form strings are rejected so a client can never self-assert an
// arbitrary role that some future authorization path might trust.
export const ALLOWED_ROLES = [
  'Writer',
  'Illustrator',
  'Composer',
  'Voice Actor',
  'Developer',
  'Producer',
  'Designer',
  'Backer',
] as const

/** Defensive filter for roles read back from user_metadata (DB is truth). */
function roleArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (r): r is string => typeof r === 'string' && (ALLOWED_ROLES as readonly string[]).includes(r)
  )
}

const passwordField = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .regex(/[a-zA-Z]/, 'password must contain a letter')
  .regex(/[0-9#?!@%^&*_-]/, 'password must contain a digit or symbol')

// Signup passwords must clear the same bar as admin panel passwords.
const signupSchema = z.object({
  email: z.string().email('invalid email address'),
  password: passwordField,
  roles: z.array(z.enum(ALLOWED_ROLES)).max(3).optional(),
})

const emailSchema = z.object({ email: z.string().email('invalid email address') })

const verifySignupSchema = z.object({
  email: z.string().email('invalid email address'),
  code: z.string().min(6).max(6, 'code must be 6 digits'),
  // The password is applied at confirmation time, so an attacker who
  // pre-claimed a pending account can never pin their own password onto
  // an account the email owner later confirms.
  password: passwordField,
})

function maskEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!domain) return email
  return `${name.slice(0, 2)}***@${domain}`
}

/**
 * POST /api/auth/signup — start email signup with a Brevo-delivered OTP.
 * Body: { email, password, roles? }
 *
 * Creates the Supabase auth user with email_confirm: false (so GoTrue never
 * sends its own email), then emails a 6-digit code via Brevo. The user does
 * not get a session until /verify confirms the code.
 */
authRouter.post('/signup', async (req, res) => {
  const body = signupSchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid request' })
  }
  const { email, password, roles } = body.data
  const normalizedEmail = email.toLowerCase().trim()

  // Protect the mailer from being spammed by signup requests.
  if (!rateLimit(`signup:${normalizedEmail}`, 3, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many signup requests, slow down' })
  }

  let authUserId: string | null = null
  const existing = await findAuthUserByEmail(normalizedEmail)
  if (existing) {
    if (existing.email_confirmed_at) {
      return res.status(409).json({ error: 'an account with this email already exists' })
    }
    // A previous signup never got confirmed — reuse the pending user.
    // Deliberately do NOT touch its password: an attacker could otherwise
    // pre-claim a victim's email and pin their own password onto an
    // account the victim later confirms. The real password is supplied
    // and applied by whoever verifies the emailed code.
    authUserId = existing.id
    const { error } = await supabaseAdmin().auth.admin.updateUserById(existing.id, {
      user_metadata: { roles: roles ?? [], auth_method: 'email' },
    })
    if (error) {
      return res.status(500).json({ error: 'account update failed, try again' })
    }
  } else {
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: false,
      user_metadata: { roles: roles ?? [], auth_method: 'email' },
    })
    if (error) {
      if (error.code === 'user_already_exists') {
        return res.status(409).json({ error: 'an account with this email already exists' })
      }
      return res.status(500).json({ error: 'could not create account, try again' })
    }
    authUserId = data.user.id
  }

  const code = randomOtpCode()
  const codeHash = await hashSecret(code)
  const now = new Date()

  const { error: otpError } = await supabaseAdmin().from('signup_otp').upsert(
    {
      email: normalizedEmail,
      user_id: authUserId,
      code_hash: codeHash,
      expires_at: new Date(now.getTime() + SIGNUP_OTP_TTL_MS).toISOString(),
      attempts: 0,
      last_sent_at: now.toISOString(),
      // Reset the single-use marker explicitly: an upsert only overwrites
      // the columns it is given, so a stale used_at would otherwise stick.
      used_at: null,
    },
    { onConflict: 'email' }
  )
  if (otpError) {
    return res.status(500).json({ error: 'could not start verification' })
  }

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'Your AnieLab verification code',
      html: otpEmailHtml(code, 'Use this code to verify your email and finish creating your AnieLab account.'),
    })
  } catch (err) {
    console.error('Signup OTP email failed:', err)
    return res.status(500).json({ error: 'failed to send verification email' })
  }

  return res.json({ otp_required: true, email: maskEmail(normalizedEmail) })
})

/**
 * POST /api/auth/signup/verify — confirm the emailed code and mint a session.
 * Body: { email, code, password }
 *
 * Consumes the code atomically (used_at claim — two parallel requests with
 * the same code cannot both win), applies the password supplied here, marks
 * the auth user confirmed, records the users row, and returns a magic-link
 * token hash the client exchanges for a real Supabase session (same trick
 * the wallet flow uses). If a later step fails, the claim is released so
 * the code stays valid for a retry.
 */
authRouter.post('/signup/verify', async (req, res) => {
  const body = verifySignupSchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid request' })
  }
  const { email, code, password } = body.data
  const normalizedEmail = email.toLowerCase().trim()

  if (!rateLimit(`signupverify:${normalizedEmail}`, 15, 60 * 1000)) {
    return res.status(429).json({ error: 'too many attempts, slow down' })
  }

  const { data: otp, error } = await supabaseAdmin()
    .from('signup_otp')
    .select('*')
    .eq('email', normalizedEmail)
    .single()

  if (error || !otp) {
    return res.status(403).json({ error: 'no pending code — start signup again' })
  }
  if (otp.used_at) {
    return res.status(403).json({ error: 'code already used — start signup again' })
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return res.status(403).json({ error: 'code expired — request a new one' })
  }
  if ((otp.attempts as number) >= SIGNUP_OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too many attempts — request a new code' })
  }

  const ok = await verifySecret(code.trim(), otp.code_hash as string)
  if (!ok) {
    await supabaseAdmin()
      .from('signup_otp')
      .update({ attempts: (otp.attempts as number) + 1 })
      .eq('email', normalizedEmail)
      .eq('used_at', null)
    return res.status(403).json({ error: 'invalid code' })
  }

  // Single-use: claim the code atomically. Only the request that flips
  // used_at from null to now gets to finish the signup — a racing duplicate
  // verify with the same code loses here instead of both winning.
  const { data: claimed, error: claimError } = await supabaseAdmin()
    .from('signup_otp')
    .update({ used_at: new Date().toISOString() })
    .eq('email', normalizedEmail)
    .eq('used_at', null)
    .select()
    .maybeSingle()
  if (claimError || !claimed) {
    return res.status(403).json({ error: 'code already used — start signup again' })
  }

  const user = await findAuthUserByEmail(normalizedEmail)
  if (!user) {
    // Pending account vanished (e.g. user deleted) — release the claim so
    // the email owner can start over with a fresh signup.
    await supabaseAdmin().from('signup_otp').delete().eq('email', normalizedEmail)
    return res.status(403).json({ error: 'account not found — start signup again' })
  }

  // Apply the password chosen by whoever holds the emailed code, and confirm
  // the account in the same call. A password an attacker pinned onto a
  // pending account never survives this step.
  const { error: confirmError } = await supabaseAdmin().auth.admin.updateUserById(user.id, {
    password,
    email_confirm: true,
  })
  if (confirmError) {
    // Transient GoTrue failure — release the claim so the code stays valid.
    await supabaseAdmin().from('signup_otp').delete().eq('email', normalizedEmail)
    return res.status(500).json({ error: 'could not confirm account, try again' })
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const roles = roleArray(meta.roles)

  const { error: userError } = await supabaseAdmin().from('users').upsert(
    {
      id: user.id,
      auth_method: 'email',
      roles,
    },
    { onConflict: 'id' }
  )
  if (userError) {
    console.warn('users row upsert failed on signup verify:', userError.message)
  }

  // Hand the client a magic-link token so it can exchange it for a real
  // session with supabase.auth.verifyOtp — no raw password ever touches
  // the client session exchange.
  const { data: linkData, error: linkError } = await supabaseAdmin().auth.admin.generateLink({
    type: 'magiclink',
    email: normalizedEmail,
  })
  if (linkError || !linkData) {
    // Account is confirmed and password is set — release the claim and let
    // the user just sign in with their password.
    await supabaseAdmin().from('signup_otp').delete().eq('email', normalizedEmail)
    return res.status(500).json({ error: 'account confirmed — sign in with your password' })
  }

  // Claimed and consumed — tidy up the single-use row.
  await supabaseAdmin().from('signup_otp').delete().eq('email', normalizedEmail)

  // Signup-success email — best effort, never blocks the sign-in.
  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'Welcome to AnieLab 🎉',
      html: signupSuccessEmailHtml(''),
    })
  } catch (err) {
    console.error('Welcome email failed:', err)
  }

  return res.json({ verified: true, tokenHash: linkData.properties.hashed_token })
})

/** POST /api/auth/signup/resend — re-send the signup code (60s cooldown). */
authRouter.post('/signup/resend', async (req, res) => {
  const body = emailSchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid request' })
  }
  const normalizedEmail = body.data.email.toLowerCase().trim()

  // Uncapped resends would let an attacker who pre-claimed an email keep
  // the mailer bombarding that inbox forever (the 60s cooldown alone only
  // throttles the rate, not the sustained total). Cap per mailbox.
  if (!rateLimit(`signupresend:${normalizedEmail}`, 6, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many resends, try again later' })
  }

  const { data: otp } = await supabaseAdmin()
    .from('signup_otp')
    .select('*')
    .eq('email', normalizedEmail)
    .single()

  if (!otp) return res.status(403).json({ error: 'no pending signup — start again' })

  const lastSent = otp.last_sent_at ? new Date(otp.last_sent_at).getTime() : 0
  if (Date.now() - lastSent < SIGNUP_OTP_RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: 'wait a minute before resending' })
  }

  const authUserId = otp.user_id as string | null
  if (!authUserId) return res.status(500).json({ error: 'pending signup has no account' })

  const { data: authUser, error: userFetchError } = await supabaseAdmin().auth.admin.getUserById(authUserId)
  if (userFetchError || !authUser) {
    return res.status(500).json({ error: 'could not find pending account' })
  }

  const code = randomOtpCode()
  const codeHash = await hashSecret(code)
  const now = new Date()

  const { error: updateError } = await supabaseAdmin().from('signup_otp').update({
    code_hash: codeHash,
    expires_at: new Date(now.getTime() + SIGNUP_OTP_TTL_MS).toISOString(),
    attempts: 0,
    last_sent_at: now.toISOString(),
    used_at: null,
  }).eq('email', normalizedEmail)
  if (updateError) {
    return res.status(500).json({ error: 'could not re-issue code' })
  }

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'Your AnieLab verification code',
      html: otpEmailHtml(code, 'Use this code to verify your email and finish creating your AnieLab account.'),
    })
  } catch (err) {
    console.error('Signup OTP resend failed:', err)
    return res.status(500).json({ error: 'failed to send verification email' })
  }

  return res.json({ sent: true })
})

const challengeSchema = z.object({
  stellarAddress: z.string(),
})

const verifySchema = z.object({
  stellarAddress: z.string(),
  nonce: z.string(),
  signature: z.string().optional(),
  signedMessage: z.string().optional(),
  roles: z.array(z.enum(ALLOWED_ROLES)).max(3).optional(),
})

/**
 * POST /api/auth/challenge — mint a one-time sign-in nonce for a wallet.
 */
authRouter.post('/challenge', async (req, res) => {
  const body = challengeSchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: 'invalid request' })
  }
  const { stellarAddress } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return res.status(400).json({ error: 'invalid stellar address' })
  }

  // Don't let one address mint unlimited nonces — an attacker could otherwise
  // fill auth_challenges and spam the sign-in flow.
  if (!rateLimit(`challenge:${stellarAddress}`)) {
    return res.status(429).json({ error: 'too many challenge requests, slow down' })
  }

  const nonce = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { error } = await supabaseAdmin()
    .from('auth_challenges')
    .insert({ stellar_address: stellarAddress, nonce, expires_at: expiresAt })

  if (error) {
    return res.status(500).json({ error: 'challenge creation failed' })
  }

  return res.json({
    nonce,
    message: buildSignInMessage(nonce),
    expiresAt,
  })
})

/** Deterministic synthetic email so wallet users exist in Supabase auth.users. */
function syntheticEmail(stellarAddress: string): string {
  return `${stellarAddress.toLowerCase()}@siws.anielab.app`
}

async function findAuthUserByEmail(email: string) {
  // listUsers is paginated (max perPage 1000) — scanning only page 1 would
  // silently miss every user past the first thousand, locking them out of
  // signup and wallet sign-in forever. Walk pages until found or exhausted.
  let page = 1
  while (page <= 50) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: 1000 })
    if (error || !data) return null
    const found = data.users.find((u) => u.email === email)
    if (found) return found
    if (data.users.length < 1000) return null
    page++
  }
  return null
}

/**
 * Ensures a Supabase auth user exists for the wallet address, returning its
 * id plus the roles stored in its user_metadata (the source of truth — the
 * request body may claim roles, but only a brand-new user ever gets them).
 * The users.id column references auth.users.id, so RLS keyed on auth.uid()
 * works for wallet-authenticated sessions exactly like email sessions.
 */
async function ensureAuthUser(
  stellarAddress: string,
  roles?: string[]
): Promise<{ id: string; roles: string[] }> {
  const email = syntheticEmail(stellarAddress)
  const existing = await findAuthUserByEmail(email)
  if (existing) {
    return { id: existing.id, roles: roleArray(existing.user_metadata?.roles) }
  }

  const { data, error } = await supabaseAdmin().auth.admin.createUser({
    email,
    password: randomBytes(24).toString('base64'),
    email_confirm: true,
    user_metadata: {
      stellar_address: stellarAddress,
      auth_method: 'wallet',
      ...(roles && roles.length > 0 ? { roles } : {}),
    },
  })
  if (error && error.code !== 'user_already_exists') {
    throw new Error(`auth user creation failed: ${error.message}`)
  }
  if (data?.user) {
    return { id: data.user.id, roles: roleArray(data.user.user_metadata?.roles) }
  }

  const race = await findAuthUserByEmail(email)
  if (race) return { id: race.id, roles: roleArray(race.user_metadata?.roles) }
  throw new Error('could not resolve auth user')
}

/**
 * POST /api/auth/verify — verify a wallet signature and issue a session.
 */
authRouter.post('/verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body)
  if (!body.success) {
    return res.status(400).json({ error: 'invalid request' })
  }
  const { stellarAddress, nonce, signature, signedMessage, roles } = body.data

  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    return res.status(400).json({ error: 'invalid stellar address' })
  }

  const { data: challenge, error } = await supabaseAdmin()
    .from('auth_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('nonce', nonce)
    .single()

  if (error || !challenge) {
    return res.status(400).json({ error: 'unknown challenge' })
  }
  if (challenge.used_at) {
    return res.status(400).json({ error: 'challenge already used' })
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'challenge expired' })
  }

  if (!verifySignature(stellarAddress, nonce, { signature, signedMessage })) {
    return res.status(401).json({ error: 'signature verification failed' })
  }

  // Single-use: claim the challenge atomically. A racing duplicate verify
  // with the same nonce loses here instead of both minting sessions.
  const { data: claimed, error: claimError } = await supabaseAdmin()
    .from('auth_challenges')
    .update({ used_at: new Date().toISOString() })
    .eq('id', challenge.id)
    .eq('used_at', null)
    .select()
    .maybeSingle()
  if (claimError || !claimed) {
    return res.status(409).json({ error: 'challenge already used' })
  }

  try {
    const { id: authUserId, roles: userRoles } = await ensureAuthUser(stellarAddress, roles)

    const { data: user, error: userError } = await supabaseAdmin()
      .from('users')
      .upsert(
        {
          id: authUserId,
          stellar_address: stellarAddress,
          auth_method: 'wallet',
          // Roles claimed at first sign-in ride into the profile row too,
          // matching the metadata on auth.users (the source of truth).
          roles: userRoles,
        },
        { onConflict: 'id' }
      )
      .select()
      .single()

    if (userError) {
      return res.status(500).json({ error: 'user creation failed' })
    }

    // Exchange the verified signature for a REAL Supabase session: generate a
    // magic-link token for the user's synthetic email, then hand it to the
    // client. `supabase.auth.verifyOtp` swaps it for a proper access + refresh
    // token pair that GoTrue manages and the frontend stores as cookies.
    const email = syntheticEmail(stellarAddress)
    const { data: linkData, error: linkError } = await supabaseAdmin().auth.admin.generateLink({
      type: 'magiclink',
      email,
    })
    if (linkError || !linkData) {
      return res.status(500).json({ error: 'session link generation failed' })
    }

    return res.json({
      verified: true,
      user,
      email,
      tokenHash: linkData.properties.hashed_token,
    })
  } catch (err) {
    console.error('Wallet auth failed:', err)
    return res.status(500).json({ error: 'wallet auth failed' })
  }
})

// Maintain auth_challenges: sweep consumed or long-expired nonces hourly so
// the table can't grow unbounded (challenge: rate limiting caps bursts per
// address but not the total row count across addresses).
setInterval(async () => {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  try {
    await supabaseAdmin()
      .from('auth_challenges')
      .delete()
      .or(`used_at.not.is.null,expires_at.lt.${cutoff}`)
  } catch (err) {
    console.error('auth_challenges sweep failed:', err)
  }
}, 60 * 60 * 1000).unref()
