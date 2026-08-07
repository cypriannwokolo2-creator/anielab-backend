import { Client } from 'minio'

const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
})

const BUCKET = process.env.MINIO_BUCKET || 'anielab-media'

/**
 * Returns a presigned PUT URL that the browser can use to upload a file
 * directly to MinIO without the file going through the backend.
 * The URL expires after `expiry` seconds (default 1 hour).
 */
export async function presignedPutUrl(
  objectKey: string,
  expiry = 3600,
): Promise<string> {
  const url = await minio.presignedPutObject(BUCKET, objectKey, expiry)
  return url
}

/**
 * Returns the public, cached URL for a MinIO object served through Caddy.
 * Example: https://minio.anielab.app/anielab-media/uploads/abc/cover.jpg
 */
export function publicUrl(objectKey: string): string {
  const base = process.env.NEXT_PUBLIC_MEDIA_BASE_URL || 'https://minio.anielab.app'
  return `${base}/${BUCKET}/${objectKey}`
}