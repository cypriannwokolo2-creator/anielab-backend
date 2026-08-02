import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { pinata } from '@/lib/pinata'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Pins a file to IPFS via Pinata. Requires a Supabase session
 * (`Authorization: Bearer <access token>`).
 */
export async function POST(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) {
    return NextResponse.json({ error: 'missing authorization' }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing file' }, { status: 400 })
  }

  try {
    const result = await pinata.upload.public.file(file)
    return NextResponse.json({
      cid: result.cid,
      url: `https://${process.env.NEXT_PUBLIC_PINATA_GATEWAY}/ipfs/${result.cid}`,
    })
  } catch (err) {
    console.error('Pinata upload failed:', err)
    return NextResponse.json({ error: 'upload failed' }, { status: 500 })
  }
}
