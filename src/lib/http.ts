import { NextResponse } from 'next/server'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS_HEADERS })
}

export function optionsOk() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export function isOptions(req: Request): boolean {
  return req.method === 'OPTIONS'
}
