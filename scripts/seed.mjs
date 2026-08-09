#!/usr/bin/env node
/**
 * AnieLab seed script — populates the database with 5 demo projects,
 * cover art, milestones, contributors, pledges, a challenge, and
 * platform settings.
 *
 * Usage:
 *   cd anielab-backend
 *   node --env-file=.env scripts/seed.mjs
 *
 * Requires: SUPABASE_SERVICE_ROLE_KEY, MINIO_ENDPOINT, MINIO_ACCESS_KEY,
 *           MINIO_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL in env.
 * Images: scripts/seed-images/*.png
 */

import { createClient } from '@supabase/supabase-js'
import { Client } from 'minio'
import { readFileSync, readdirSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio'
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY
const BUCKET = process.env.MINIO_BUCKET || 'anielab-media'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const minio = new Client({
  endPoint: MINIO_ENDPOINT,
  port: 9000,
  useSSL: false,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
})

// ─── Helpers ───────────────────────────────────────────────────────────
const IMAGES_DIR = join(__dirname, 'seed-images')

async function ensureBucket() {
  const exists = await minio.bucketExists(BUCKET)
  if (!exists) {
    await minio.makeBucket(BUCKET, 'us-east-1')
    console.log(`  Created bucket: ${BUCKET}`)
  }
}

async function uploadImage(filePath) {
  const key = `seed/${basename(filePath, extname(filePath))}-${Date.now()}${extname(filePath)}`
  const buf = readFileSync(filePath)
  const contentType = extname(filePath) === '.png' ? 'image/png' : 'image/jpeg'
  await minio.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType })
  console.log(`  Uploaded: ${key}`)
  return key
}

/** Create a demo user via Supabase admin API. Returns the user id. */
async function createDemoUser(email, stellarAddress, displayName) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: 'demo-password-123',
    email_confirm: true,
    user_metadata: {
      stellar_address: stellarAddress,
      display_name: displayName,
      auth_method: 'wallet',
    },
  })
  if (error) {
    // User might already exist — look them up.
    const { data: list } = await supabase.auth.admin.listUsers()
    const existing = list?.users?.find((u) => u.email === email)
    if (existing) {
      console.log(`  User already exists: ${email} (${existing.id})`)
      return existing.id
    }
    throw new Error(`Failed to create user: ${error.message}`)
  }
  console.log(`  Created user: ${email} (${data.user.id})`)
  return data.user.id
}

/** Ensure a users row exists in public.users for the given auth id. */
async function ensureUserProfile(userId, stellarAddress, displayName) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .single()
  if (existing) return

  const { error } = await supabase.from('users').insert({
    id: userId,
    stellar_address: stellarAddress,
    display_name: displayName,
    auth_method: 'wallet',
  })
  if (error) {
    console.warn(`  Could not insert user profile: ${error.message}`)
  }
}

// ─── Seed data ─────────────────────────────────────────────────────────
const DEMO_USERS = [
  { email: 'sakura@demo.anielab.app', address: 'GDEMO1SAKURA000000000000000000000000000000000000000000', name: 'Sakura Studio' },
  { email: 'ronin@demo.anielab.app', address: 'GDEMO2RONIN0000000000000000000000000000000000000000000', name: 'Ronin Comics' },
  { email: 'genesis@demo.anielab.app', address: 'GDEMO3GENESIS00000000000000000000000000000000000000000', name: 'Genesis Mecha' },
  { email: 'pixel@demo.anielab.app', address: 'GDEMO4PIXEL0000000000000000000000000000000000000000000', name: 'Pixel Dreams' },
  { email: 'lofi@demo.anielab.app', address: 'GDEMO5LOFI00000000000000000000000000000000000000000000', name: 'LoFi Labs' },
]

const PROJECTS = [
  {
    title: 'Stellar Sakura — OVA',
    description: 'A breathtaking anime OVA following Captain Sakura as she navigates the last cherry blossom garden in the galaxy. 3 episodes, hand-drawn animation with orchestral soundtrack.',
    fundingGoal: 50000, // USDC (raw: * 1e7)
    status: 'active',
    image: 'stellar-sakura.png',
    contractId: 'CDEMO1STELLS4KURA000000000000000000000000000000000000000',
    milestones: [
      { title: 'Storyboard & Concept Art', pct_bps: 2000 },
      { title: 'Animation Production', pct_bps: 4500 },
      { title: 'Sound Design & OST', pct_bps: 2000 },
      { title: 'Final Edit & Release', pct_bps: 1500 },
    ],
    contributors: [
      { role: 'Director', share_pct: 40, userIndex: 0 },
      { role: 'Lead Animator', share_pct: 30, userIndex: 1 },
      { role: 'Composer', share_pct: 20, userIndex: 4 },
      { role: 'Producer', share_pct: 10, userIndex: 2 },
    ],
    pledges: [
      { backer: 'GBACKER100000000000000000000000000000000000000000000001', amount: 15000 },
      { backer: 'GBACKER200000000000000000000000000000000000000000000002', amount: 8000 },
      { backer: 'GBACKER300000000000000000000000000000000000000000000003', amount: 5500 },
    ],
  },
  {
    title: 'Neon Ronin — Graphic Novel',
    description: 'A 200-page cyberpunk graphic novel set in Neo-Tokyo 2099. Follows a disgraced samurai turned mercenary navigating corporate warfare. Full color, printed + digital.',
    fundingGoal: 25000,
    status: 'active',
    image: 'neon-ronin.png',
    contractId: 'CDEMO2NEONRONIN0000000000000000000000000000000000000000',
    milestones: [
      { title: 'Script & Storyboard', pct_bps: 1500 },
      { title: 'Illustration Phase 1', pct_bps: 3500 },
      { title: 'Illustration Phase 2', pct_bps: 3000 },
      { title: 'Print & Distribution', pct_bps: 2000 },
    ],
    contributors: [
      { role: 'Writer', share_pct: 30, userIndex: 1 },
      { role: 'Illustrator', share_pct: 50, userIndex: 0 },
      { role: 'Colorist', share_pct: 20, userIndex: 3 },
    ],
    pledges: [
      { backer: 'GBACKER400000000000000000000000000000000000000000000004', amount: 12000 },
      { backer: 'GBACKER500000000000000000000000000000000000000000000005', amount: 3000 },
    ],
  },
  {
    title: 'Mecha Genesis — Mobile Game',
    description: 'Build and pilot custom mechs in this turn-based tactical RPG. Features a deep crafting system, PvP arena, and story campaign. Coming to iOS, Android, and Steam.',
    fundingGoal: 100000,
    status: 'active',
    image: 'mecha-genesis.png',
    contractId: 'CDEMO3MECH4GENESIS00000000000000000000000000000000000000',
    milestones: [
      { title: 'Prototype & Core Loop', pct_bps: 2500 },
      { title: 'Art & Animation Pipeline', pct_bps: 3000 },
      { title: 'Multiplayer & PvP', pct_bps: 2500 },
      { title: 'Launch & Marketing', pct_bps: 2000 },
    ],
    contributors: [
      { role: 'Game Designer', share_pct: 35, userIndex: 2 },
      { role: 'Lead Developer', share_pct: 35, userIndex: 3 },
      { role: '3D Artist', share_pct: 20, userIndex: 0 },
      { role: 'Sound Designer', share_pct: 10, userIndex: 4 },
    ],
    pledges: [
      { backer: 'GBACKER600000000000000000000000000000000000000000000006', amount: 35000 },
      { backer: 'GBACKER700000000000000000000000000000000000000000000007', amount: 20000 },
      { backer: 'GBACKER100000000000000000000000000000000000000000000001', amount: 10000 },
      { backer: 'GBACKER800000000000000000000000000000000000000000000008', amount: 5000 },
    ],
  },
  {
    title: 'Pixel Odyssey — Indie Game',
    description: 'A charming 16-bit style space exploration game. Procedurally generated galaxies, alien diplomacy, and base building. Early access in 6 months.',
    fundingGoal: 15000,
    status: 'active',
    image: 'pixel-odyssey.png',
    contractId: 'CDEMO4PIXELODYSSEY00000000000000000000000000000000000000',
    milestones: [
      { title: 'Engine & Core Systems', pct_bps: 3000 },
      { title: 'Content & Levels', pct_bps: 4000 },
      { title: 'Beta Testing & Polish', pct_bps: 3000 },
    ],
    contributors: [
      { role: 'Developer', share_pct: 60, userIndex: 3 },
      { role: 'Pixel Artist', share_pct: 30, userIndex: 1 },
      { role: 'Composer', share_pct: 10, userIndex: 4 },
    ],
    pledges: [
      { backer: 'GBACKER900000000000000000000000000000000000000000000009', amount: 8000 },
      { backer: 'GBACKER200000000000000000000000000000000000000000000002', amount: 4500 },
    ],
  },
  {
    title: 'LoFi Constellation — Album',
    description: 'A 12-track lo-fi hip hop album with anime-inspired visuals. Each track comes with an animated loop video. Released on streaming + limited vinyl.',
    fundingGoal: 8000,
    status: 'active',
    image: 'lofi-constellation.png',
    contractId: 'CDEMO5LOFICONSTELLATION00000000000000000000000000000000',
    milestones: [
      { title: 'Beat Production', pct_bps: 3500 },
      { title: 'Visual Art & Animation', pct_bps: 3000 },
      { title: 'Mixing & Mastering', pct_bps: 2000 },
      { title: 'Vinyl Pressing & Release', pct_bps: 1500 },
    ],
    contributors: [
      { role: 'Producer', share_pct: 50, userIndex: 4 },
      { role: 'Visual Artist', share_pct: 30, userIndex: 0 },
      { role: 'Mixing Engineer', share_pct: 20, userIndex: 2 },
    ],
    pledges: [
      { backer: 'GBACKER300000000000000000000000000000000000000000000003', amount: 3000 },
      { backer: 'GBACKER500000000000000000000000000000000000000000000005', amount: 2000 },
      { backer: 'GBACKER100000000000000000000000000000000000000000000000A', amount: 1500 },
    ],
  },
]

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ AnieLab Seed ═══\n')

  // 1. Ensure MinIO bucket exists.
  console.log('[1/7] Setting up MinIO bucket…')
  await ensureBucket()

  // 2. Create demo users.
  console.log('\n[2/7] Creating demo users…')
  const userIds = []
  for (const u of DEMO_USERS) {
    const id = await createDemoUser(u.email, u.address, u.name)
    await ensureUserProfile(id, u.address, u.name)
    userIds.push(id)
  }

  // 3. Upload cover images.
  console.log('\n[3/7] Uploading cover images…')
  const imageKeys = {}
  const imageFiles = readdirSync(IMAGES_DIR).filter((f) => f.endsWith('.png') || f.endsWith('.jpg'))
  for (const file of imageFiles) {
    const key = await uploadImage(join(IMAGES_DIR, file))
    imageKeys[basename(file, extname(file))] = key
  }

  // 4. Create projects with milestones and contributors.
  console.log('\n[4/7] Creating projects…')
  const projectIds = []
  for (const proj of PROJECTS) {
    const imageKey = imageKeys[basename(proj.image, extname(proj.image))] || null
    const ownerId = userIds[0] // first demo user owns all for simplicity

    const { data: project, error: projErr } = await supabase
      .from('projects')
      .insert({
        owner_id: ownerId,
        title: proj.title,
        description: proj.description,
        cover_ipfs_cid: imageKey,
        contract_id: proj.contractId,
        funding_goal: Math.round(proj.fundingGoal * 1e7),
        status: proj.status,
        total_pledged: 0,
        milestone_count: proj.milestones.length,
      })
      .select('id')
      .single()

    if (projErr) {
      // May already exist — look up by title.
      const { data: existing } = await supabase
        .from('projects')
        .select('id')
        .eq('title', proj.title)
        .single()
      if (existing) {
        console.log(`  Project already exists: ${proj.title} (${existing.id})`)
        projectIds.push(existing.id)
        continue
      }
      console.error(`  Failed to create project "${proj.title}": ${projErr.message}`)
      continue
    }

    console.log(`  Created: ${proj.title} (${project.id})`)
    projectIds.push(project.id)

    // Milestones
    const milestones = proj.milestones.map((m, i) => ({
      project_id: project.id,
      title: m.title,
      pct_bps: m.pct_bps,
      sort_order: i,
      released: false,
    }))
    const { error: msErr } = await supabase.from('milestones').insert(milestones)
    if (msErr) console.warn(`  Milestones error: ${msErr.message}`)

    // Contributors
    for (const c of proj.contributors) {
      const contributorUserId = userIds[c.userIndex]
      const { error: cErr } = await supabase.from('contributions').insert({
        project_id: project.id,
        user_id: contributorUserId,
        role: c.role,
        share_pct: c.share_pct,
      })
      if (cErr) console.warn(`  Contributor error: ${cErr.message}`)
    }
  }

  // 5. Insert pledges.
  console.log('\n[5/7] Inserting pledges…')
  for (let i = 0; i < PROJECTS.length; i++) {
    const proj = PROJECTS[i]
    const projectId = projectIds[i]
    if (!projectId) continue

    let totalPledged = 0
    for (const pledge of proj.pledges) {
      const rawAmount = Math.round(pledge.amount * 1e7)
      const fee = Math.round(rawAmount * 0.05) // 5% platform fee
      const { error } = await supabase.from('pledges').insert({
        project_id: projectId,
        backer_address: pledge.backer,
        amount: rawAmount,
        fee,
        currency: 'USDC',
        tx_hash: `DEMO${randomUUID().replace(/-/g, '').slice(0, 56)}`,
      })
      if (error) {
        console.warn(`  Pledge error: ${error.message}`)
      } else {
        totalPledged += rawAmount
      }
    }

    // total_pledged is auto-updated by the trg_pledge_update_total trigger.
    console.log(`  ${proj.title}: ${(totalPledged / 1e7).toFixed(0)} USDC pledged (via trigger)`)
  }

  // 6. Create a demo challenge.
  console.log('\n[6/7] Creating demo challenge…')
  const now = new Date()
  const startsAt = new Date(now.getTime() - 2 * 86400000) // started 2 days ago
  const endsAt = new Date(now.getTime() + 12 * 86400000) // ends in 12 days

  const { data: challenge, error: chErr } = await supabase
    .from('challenges')
    .insert({
      title: 'Design a Rival Mech',
      description: 'The Genesis Mecha needs a worthy opponent. Design a rival mech that could stand toe-to-toe in the arena. Submissions should include front and side views.',
      theme: 'Rival Mech Design',
      prize_pool: Math.round(2000 * 1e7), // 2000 USDC
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'active',
      created_by: userIds[2], // Genesis Mecha user
    })
    .select('id')
    .single()

  if (chErr) {
    console.warn(`  Challenge error: ${chErr.message}`)
  } else {
    console.log(`  Created challenge: ${challenge.id}`)

    // Add a few demo entries.
    const entries = [
      { title: 'Iron Viper Mk.II', description: 'A sleek serpentine mech built for speed and ambush tactics.', votes: 12, rank: 1, userIndex: 0 },
      { title: 'Titan Forge', description: 'A massive walking fortress with heavy artillery and shield systems.', votes: 8, rank: 2, userIndex: 1 },
      { title: 'Phantom Striker', description: 'Stealth-focused mech with active camouflage and EMP weapons.', votes: 5, rank: null, userIndex: 3 },
    ]
    for (const entry of entries) {
      const { error: entryErr } = await supabase.from('challenge_entries').insert({
        challenge_id: challenge.id,
        user_id: userIds[entry.userIndex],
        title: entry.title,
        description: entry.description,
        votes: entry.votes,
        rank: entry.rank,
      })
      if (entryErr) console.warn(`  Entry error: ${entryErr.message}`)
    }
    console.log(`  Added ${entries.length} challenge entries`)
  }

  // 7. Platform settings.
  console.log('\n[7/7] Setting platform defaults…')
  const { error: settingsErr } = await supabase.from('platform_settings').upsert(
    {
      id: 1,
      platform_fee_bps: 500, // 5%
      platform_wallet: 'GPLATFORM000000000000000000000000000000000000000000',
    },
    { onConflict: 'id' }
  )
  if (settingsErr) {
    console.warn(`  Settings error: ${settingsErr.message}`)
  } else {
    console.log('  Platform fee: 5% (500 bps)')
  }

  console.log('\n═══ Seed complete! ═══')
  console.log(`  ${projectIds.length} projects, ${DEMO_USERS.length} users, 1 challenge`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
