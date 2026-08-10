/**
 * Brevo transactional email client (REST v3) — used for admin OTP codes,
 * new-user signup verification codes, and the post-signup welcome email.
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

/**
 * Shared branded letter shell. Inline styles only — most mail clients strip
 * <style> blocks, so everything lives on the element itself.
 */
function letterShell(opts: {
  badge: string
  title: string
  body: string
  cta?: { href: string; label: string }
  note?: string
}): string {
  const { badge, title, body, cta, note } = opts
  return `
  <!doctype html>
  <html lang="en">
  <body style="margin:0;padding:0;background-color:#0c0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0c0a09">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" width="100%" style="max-width:540px;background-color:#1c1917;border:1px solid #292524;border-radius:20px;overflow:hidden">
            <tr>
              <td align="center" style="padding:28px 28px 0">
                <div style="font-size:13px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#f59e0b">${badge}</div>
                <h1 style="margin:10px 0 0;font-size:24px;line-height:1.3;color:#fafaf9;font-weight:700">${title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 28px;color:#d6d3d1;font-size:15px;line-height:1.7" align="center">
                ${body}
                ${cta ? `
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 0">
                  <tr>
                    <td align="center" style="border-radius:9999px;background:linear-gradient(180deg,#fcd34d,#f59e0b);padding:14px 32px;font-size:14px;font-weight:700">
                      <a href="${cta.href}" style="color:#1c1917;text-decoration:none;display:block">${cta.label}</a>
                    </td>
                  </tr>
                </table>` : ''}
                ${note ? `<p style="margin:24px 0 0;font-size:12.5px;line-height:1.6;color:#78716c">${note}</p>` : ''}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:16px 28px 24px;border-top:1px solid #292524;font-size:12px;color:#78716c">
                AnieLab · Back the ideas that move you<br/>
                <span style="color:#57534e">If you didn't ask for this email, you can safely ignore it.</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`
}

/** Generic branded OTP code card. */
export function otpEmailHtml(code: string, purpose: string): string {
  return letterShell({
    badge: 'Verification code',
    title: 'Your one-time code',
    body: `
      <p style="margin:0 0 20px">${purpose}</p>
      <div style="display:inline-block;background:#292524;border:1px solid #44403c;border-radius:16px;padding:18px 32px;letter-spacing:0.35em;font-size:30px;font-weight:700;color:#fbbf24;font-family:'SF Mono',Menlo,Consolas,monospace">${code}</div>
      <p style="margin:20px 0 0;font-size:13px;color:#a8a29e">The code expires in 5 minutes. Never share it with anyone — AnieLab will never ask you for it.</p>`,
    note: `Sent to ${config.brevo.senderName} on behalf of AnieLab. If you didn't request this code, someone may be trying to access your account — change your password immediately.`,
  })
}

/** Post-signup welcome email. */
export function signupSuccessEmailHtml(displayName: string): string {
  const greeting = displayName ? `Welcome, ${displayName}!` : 'Welcome to AnieLab!'
  return letterShell({
    badge: 'You made it',
    title: 'Your account is ready',
    body: `
      <p style="margin:0 0 14px">${greeting}</p>
      <p style="margin:0 0 14px">You're now part of AnieLab — the place where writers, artists, developers, and backers bring creative projects to life. Explore projects to fund, or start one of your own and share it with the world.</p>`,
    cta: { href: 'https://app.anielab.app/dashboard', label: 'Go to your dashboard' },
    note: `If you didn't create an AnieLab account with this address, let us know and we'll sort it out.`,
  })
}

/** Admin panel OTP uses the generic template with an admin-specific purpose. */
export function adminOtpEmailHtml(code: string): string {
  return otpEmailHtml(code, 'Use this code to unlock the AnieLab admin panel.')
}