#!/usr/bin/env node
/**
 * Direct SQL runner for Supabase Postgres (migrations, one-off fixes).
 *
 * The service-role key cannot execute arbitrary SQL by design, so schema
 * changes go through the direct Postgres connection instead.
 *
 * Usage:
 *   DATABASE_URL='postgresql://postgres:***@db.<ref>.supabase.co:5432/postgres' \
 *     node scripts/run-sql.mjs path/to/file.sql
 *
 * The connection string is passed via env only — never committed.
 */
import pg from 'pg'
import { readFileSync } from 'fs'

const url = process.env.DATABASE_URL
const file = process.argv[2]

if (!url) {
  console.error('DATABASE_URL is required (postgresql://… connection string).')
  process.exit(1)
}
if (!file) {
  console.error('Usage: node scripts/run-sql.mjs <file.sql>')
  process.exit(1)
}

// Parse the URL so `family: 4` (force IPv4) and a connect timeout apply —
// pg ignores these options when given a raw connection string. The Supabase
// pooler presents a self-signed cert, so identity verification is replaced by
// CA pinning when SUPABASE_POOLER_CA points at the pinned cert (encryption
// still enforced). Direct db.<ref> hosts verify normally.
const parsed = new URL(url)
const caPath = process.env.SUPABASE_POOLER_CA
const ssl = parsed.hostname.includes('pooler.supabase.com')
  ? caPath
    ? { ca: readFileSync(caPath, 'utf-8'), rejectUnauthorized: true }
    : { rejectUnauthorized: false } // pooler self-signs; encryption still enforced
  : true
const client = new pg.Client({
  host: parsed.hostname,
  port: Number(parsed.port || 5432),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password ?? ''),
  database: parsed.pathname.replace(/^\//, '') || 'postgres',
  ssl,
  family: 4,
  connectionTimeoutMillis: 15_000,
})
await client.connect()
console.log(`Connected. Applying ${file}…`)

const sql = readFileSync(file, 'utf-8')
const res = await client.query(sql)
console.log('✓ SQL applied.', Array.isArray(res) ? `(${res.length} statement result(s))` : '')

await client.end()
