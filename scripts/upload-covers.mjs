#!/usr/bin/env node
/**
 * One-off: upload seed cover art to production MinIO (minio.anielab.app) and
 * attach the object keys to the matching demo projects.
 *
 * Run: cd anielab-backend && node --env-file=.env scripts/upload-covers.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { Client } from 'minio'
import { join, extname, basename, dirname } from 'path'
import { fileURLToPath } from 'url'
// sharp lives in the web project (Next.js dependency) — load it by absolute path.
import sharp from '../../anielab-web/node_modules/sharp/lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY
const SECRET_KEY = process.env.MINIO_SECRET_KEY
const BUCKET = process.env.MINIO_BUCKET || 'anielab-media'

if (!SUPABASE_URL || !SERVICE_KEY || !ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MINIO_ACCESS_KEY, MINIO_SECRET_KEY)')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Production MinIO is behind Caddy with TLS on port 443.
const minio = new Client({
  endPoint: 'minio.anielab.app',
  port: 443,
  useSSL: true,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
})

const IMAGES_DIR = join(__dirname, 'seed-images')

// Project id → image file (the DB seed used different titles than scripts/seed.mjs)
const MAPPING = [
  { id: '20000000-0000-4000-8000-000000000001', file: 'stellar-sakura.png' },
  { id: '20000000-0000-4000-8000-000000000002', file: 'neon-ronin.png' },
  { id: '20000000-0000-4000-8000-000000000003', file: 'mecha-genesis.png' },
  { id: '20000000-0000-4000-8000-000000000004', file: 'lofi-constellation.png' },
  { id: '20000000-0000-4000-8000-000000000005', file: 'pixel-odyssey.png' },
  { id: '20000000-0000-4000-8000-000000000006', file: 'pixel-odyssey.png' },
]

async function upload(file) {
  // Compress to a 900px-wide WebP so uploads are fast and cards load quick.
  const buf = await sharp(join(IMAGES_DIR, file))
    .resize({ width: 900 })
    .webp({ quality: 78 })
    .toBuffer()
  const key = `seed/${basename(file, extname(file))}-${Date.now()}.webp`
  await minio.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': 'image/webp' })
  console.log(`  Uploaded: ${key} (${(buf.length / 1024).toFixed(0)} KB)`)
  return key
}

async function main() {
  for (const { id, file } of MAPPING) {
    try {
      const key = await upload(file)
      const { error } = await supabase.from('projects').update({ cover_ipfs_cid: key }).eq('id', id)
      if (error) {
        console.error(`  Failed to update project ${id}: ${error.message}`)
      } else {
        console.log(`  ✓ ${id} → ${key}`)
      }
    } catch (err) {
      console.error(`  Upload failed for ${file}: ${err.message}`)
    }
  }
}

main().catch(console.error)
