import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { presignedPutUrl, publicUrl, ensureBucket } from '@/lib/stellar/minio'
import { json, isOptions, optionsOk } from '@/lib/http'
import { randomUUID } from 'node:crypto'

export const runtime = 'nodejs'
export const maxDuration = 60

// Allowed MIME types and max file size (10 MB).
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

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

  // Validate file type.
  if (!ALLOWED_TYPES.has(file.type)) {
    return json(
      { error: `unsupported file type: ${file.type}. Allowed: JPEG, PNG, WebP, GIF, SVG` },
      400,
    )
  }

  // Validate file size.
  if (file.size > MAX_FILE_SIZE) {
    return json(
      { error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: 10 MB` },
      400,
    )
  }

  try {
    // Ensure MinIO bucket exists with public-read policy.
    await ensureBucket()

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
