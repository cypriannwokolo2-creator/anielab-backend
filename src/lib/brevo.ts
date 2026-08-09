/**
 * Brevo transactional email client (REST v3) — used for admin OTP codes and,
 * later, all platform emails (signup, password reset, pledge notifications).
 * Uses global fetch; no SDK dependency.
 */
import { config, isProd } from '../config.js'

interface SendEmailArgs {
  to: string
  subject: string
  html: string
}

export async function sendEmail({ to, subject, html }: SendEmailArgs): Promise<void> {
  if (!config.brevo.apiKey) {
    if (!isProd) {
      // Dev fallback: print instead of sending so flows stay testable.
      console.log(`[brevo:dev] to=${to} subject="${subject}"\n${html}`)
      return
    }
    throw new Error('BREVO_API_KEY not configured')
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.brevo.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: config.brevo.senderEmail, name: config.brevo.senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Brevo send failed (${res.status}): ${body.slice(0, 200)}`)
  }
}

/** Simple branded wrapper for OTP codes. */
export function otpEmailHtml(code: string): string {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="color:#f59e0b;margin-bottom:8px">AnieLab admin verification</h2>
    <p style="color:#444">Use this one-time code to unlock the admin panel. It expires in 5 minutes.</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#111;background:#f5f5f4;border-radius:12px;padding:16px 24px;display:inline-block">${code}</p>
    <p style="color:#888;font-size:13px;margin-top:24px">If you did not request this, someone may have your password — change it immediately.</p>
  </div>`
}
