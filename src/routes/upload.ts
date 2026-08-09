import { Router } from 'express'
import busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import { requireUser } from '../lib/auth.js'
import { presignedPutUrl, publicUrl, ensureBucket } from '../lib/minio.js'

export const uploadRouter = Router()

// Allowed MIME types and max file size (10 MB).
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

interface FileMeta {
  name: string
  mimeType: string
  size: number
  truncated: boolean
}

/**
 * POST /api/upload — generate a presigned PUT URL for direct browser-to-MinIO
 * upload. The file never passes through the backend for storage — busboy only
 * inspects the multipart metadata (name, type, size) for validation.
 * Requires an authenticated session (`Authorization: Bearer <access token>`).
 */
uploadRouter.post('/', async (req, res) => {
  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  let bb: busboy.Busboy
  try {
    bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_FILE_SIZE + 1 } })
  } catch {
    return res.status(400).json({ error: 'invalid multipart request' })
  }

  let fileMeta: FileMeta | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      bb.on('file', (_name, stream, info) => {
        const meta: FileMeta = {
          name: info.filename,
          mimeType: info.mimeType,
          size: 0,
          truncated: false,
        }
        fileMeta = meta
        stream.on('data', (chunk: Buffer) => {
          meta.size += chunk.length
        })
        stream.on('limit', () => {
          meta.truncated = true
        })
        stream.on('error', reject)
      })
      bb.on('close', resolve)
      bb.on('error', reject)
      req.pipe(bb)
    })
  } catch {
    return res.status(400).json({ error: 'failed to parse multipart' })
  }

  const file = fileMeta as FileMeta | null
  if (!file) return res.status(400).json({ error: 'missing file' })

  // Validate file type.
  if (!ALLOWED_TYPES.has(file.mimeType)) {
    return res.status(400).json({
      error: `unsupported file type: ${file.mimeType}. Allowed: JPEG, PNG, WebP, GIF, SVG`,
    })
  }

  // Validate file size.
  if (file.truncated || file.size > MAX_FILE_SIZE) {
    return res
      .status(400)
      .json({ error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: 10 MB` })
  }

  try {
    // Ensure MinIO bucket exists with public-read policy.
    await ensureBucket()

    const ext = file.name.split('.').pop() || 'bin'
    const objectKey = `uploads/${user.id}/${randomUUID()}.${ext}`
    const presigned = await presignedPutUrl(objectKey)
    return res.json({
      key: objectKey,
      url: presigned,
      publicUrl: publicUrl(objectKey),
    })
  } catch (err) {
    console.error('Presigned URL generation failed:', err)
    return res.status(500).json({ error: 'upload failed' })
  }
})
