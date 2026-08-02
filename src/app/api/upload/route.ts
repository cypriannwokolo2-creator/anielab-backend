import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { pinata } from '@/lib/pinata'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Pins a file to IPFS via Pinata. Requires an authenticated session
 * (`Authorization: Bearer <access token>` — works for email and wallet users).
 */
export async function POST(req: Request) {
  if (isOptions(req)) return optionsOk()

  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) {
    return json({ error: 'missing authorization' }, 401)
  }
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) {
    return json({ error: 'unauthorized' }, 401)
  }

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return json({ error: 'missing file' }, 400)
  }

  try {
    const result = await pinata.upload.public.file(file)
    return json({
      cid: result.cid,
      url: `https://${process.env.NEXT_PUBLIC_PINATA_GATEWAY}/ipfs/${result.cid}`,
    })
  } catch (err) {
    console.error('Pinata upload failed:', err)
    return json({ error: 'upload failed' }, 500)
  }
}
