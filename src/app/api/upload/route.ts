import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { presignedPutUrl, publicUrl } from '@/lib/stellar/minio'
import { json, isOptions, optionsOk } from '@/lib/http'
import { randomUUID } from 'node:crypto'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Generates a presigned PUT URL for direct browser-to-MinIO upload.
 * The file never passes through the backend — MinIO handles it directly.
 * Requires an authenticated session (`Authorization: Bearer <access token>`).
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
    const ext = file.name.split('.').pop() || 'bin'
    const objectKey = `uploads/${user.id}/${randomUUID()}.${ext}`
    const presignedUrl = await presignedPutUrl(objectKey)
    return json({
      key: objectKey,
      url: presignedUrl,
      publicUrl: publicUrl(objectKey),
    })
  } catch (err) {
    console.error('Presigned URL generation failed:', err)
    return json({ error: 'upload failed' }, 500)
  }
}
