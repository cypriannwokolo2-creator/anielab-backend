/**
 * Admin session tokens — short-lived HMAC-signed grants issued after the
 * password + OTP check passes. Format: base64url(payload).base64url(sig).
 * Sent by the frontend on the X-Admin-Token header alongside the regular
 * Supabase Bearer token.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

export interface AdminSessionPayload {
  sub: string // Supabase user id
  email: string
  exp: number // unix seconds
}

const TOKEN_TTL_SECONDS = 12 * 60 * 60

function secret(): string {
  // Prefer an explicit secret; otherwise derive one from the service role key
  // so deployments work without an extra env var.
  if (config.adminSessionSecret) return config.adminSessionSecret
  return createHash('sha256').update(config.supabaseServiceKey).digest('hex')
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url')
}

export function issueAdminToken(sub: string, email: string): string {
  const payload: AdminSessionPayload = {
    sub,
    email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

export function verifyAdminToken(token: string | undefined | null): AdminSessionPayload | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(body)
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as AdminSessionPayload
    if (!payload.sub || typeof payload.exp !== 'number') return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
