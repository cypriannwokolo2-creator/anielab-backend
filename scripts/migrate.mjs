#!/usr/bin/env node
/**
 * Quick migration runner — applies SQL migrations to Supabase via
 * the Management API (requires SERVICE_ROLE_KEY with admin access).
 *
 * Usage: node --env-file=.env scripts/migrate.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const MIGRATIONS_DIR = join(import.meta.dirname ?? '.', '..', 'supabase', 'migrations')

async function runMigration(file) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')
  // Split by semicolons (skip empty and comments).
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))

  for (const stmt of statements) {
    const { error } = await supabase.rpc('exec_sql', { sql: stmt + ';' })
    if (error) {
      // exec_sql doesn't exist — try via direct REST.
      console.warn(`  Statement failed (expected if RPC missing): ${error.message}`)
      console.log(`  SQL: ${stmt.slice(0, 80)}…`)
      return false
    }
  }
  return true
}

// Try running each migration file.
async function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  console.log(`Found ${files.length} migration files\n`)

  for (const file of files) {
    console.log(`Applying: ${file}`)
    const ok = await runMigration(file)
    if (ok) {
      console.log('  ✓ Applied\n')
    } else {
      console.log('  ⚠ May need manual application via Supabase dashboard\n')
    }
  }
}

main().catch(console.error)
