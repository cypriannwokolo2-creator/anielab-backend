import { NextResponse } from 'next/server'

const ALLOWED_ORIGINS = new Set([
  'https://anielab.app',
  'https://www.anielab.app',
  'https://app.anielab.app',
])

/**
 * Build CORS headers, echoing back the request Origin only if it's in
 * the allowlist. Falls back to the first allowed origin.
 */
function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get('origin') ?? 'https://anielab.app'
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://anielab.app'
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Password',
    'Access-Control-Max-Age': '86400',
  }
}

export const CORS_HEADERS: Record<string, string> = corsHeaders()

export function json(data: unknown, status = 200, req?: Request) {
  return NextResponse.json(data, { status, headers: corsHeaders(req) })
}

export function optionsOk(req?: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export function isOptions(req: Request): boolean {
  return req.method === 'OPTIONS'
}
