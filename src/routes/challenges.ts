import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { requireUser, requireAdmin } from '../lib/auth.js'

export const challengesRouter = Router()

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  theme: z.string().max(200).optional(),
  prize_pool: z.number().int().min(0).default(0),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  cover_image_key: z.string().max(500).optional(),
})

const querySchema = z.object({
  status: z.enum(['upcoming', 'active', 'judging', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

/**
 * GET /api/challenges — list challenges (public).
 */
challengesRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'invalid query' })

  let query = supabaseAdmin()
    .from('challenges')
    .select('*, users(id, display_name)')
    .order('starts_at', { ascending: false })

  if (parsed.data.status) query = query.eq('status', parsed.data.status)
  if (parsed.data.limit) query = query.limit(parsed.data.limit)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'failed to fetch challenges' })
  return res.json({ challenges: data })
})

/**
 * POST /api/challenges — create a challenge (admin only).
 * Requires x-admin-password header + valid Supabase session.
 */
challengesRouter.post('/', async (req, res) => {
  const admin = await requireAdmin(req)
  if (!admin) return res.status(403).json({ error: 'admin auth required' })

  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  if (new Date(parsed.data.ends_at) <= new Date(parsed.data.starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' })
  }

  // Ensure user has a profile row.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('id', admin.id)
    .single()

  if (!userProfile) {
    return res.status(400).json({ error: 'user profile not found' })
  }

  const { data, error } = await supabaseAdmin()
    .from('challenges')
    .insert({
      title: parsed.data.title,
      description: parsed.data.description,
      theme: parsed.data.theme,
      prize_pool: parsed.data.prize_pool,
      starts_at: parsed.data.starts_at,
      ends_at: parsed.data.ends_at,
      cover_image_key: parsed.data.cover_image_key,
      created_by: admin.id,
    })
    .select()
    .single()

  if (error) {
    console.error('challenge create failed:', error)
    return res.status(500).json({ error: 'failed to create challenge' })
  }

  return res.status(201).json({ challenge: data })
})

/** Router for /api/challenges/:id/* — entries and voting. */
export const challengeDetailRouter = Router({ mergeParams: true })

const submitSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  submission_url: z.string().url().max(500).optional(),
  cover_image_key: z.string().max(500).optional(),
})

/**
 * GET /api/challenges/:id/entries — list entries for a challenge.
 */
challengeDetailRouter.get('/entries', async (req, res) => {
  const challengeId = (req.params as Record<string, string>).id

  const { data, error } = await supabaseAdmin()
    .from('challenge_entries')
    .select('*, users(id, display_name, stellar_address)')
    .eq('challenge_id', challengeId)
    .order('votes', { ascending: false })

  if (error) return res.status(500).json({ error: 'failed to fetch entries' })
  return res.json({ entries: data })
})

/**
 * POST /api/challenges/:id/entries — submit an entry (authenticated).
 * One entry per user per challenge.
 */
challengeDetailRouter.post('/entries', async (req, res) => {
  const challengeId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  // Verify challenge exists and is active.
  const { data: challenge } = await supabaseAdmin()
    .from('challenges')
    .select('id, status, ends_at')
    .eq('id', challengeId)
    .single()

  if (!challenge) return res.status(404).json({ error: 'challenge not found' })
  if (challenge.status !== 'active') {
    return res.status(400).json({ error: 'challenge is not accepting entries' })
  }
  if (new Date() > new Date(challenge.ends_at)) {
    return res.status(400).json({ error: 'challenge has ended' })
  }

  // Ensure user has a profile row.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single()

  if (!userProfile) return res.status(400).json({ error: 'user profile not found' })

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation failed', details: parsed.error.issues })
  }

  const { data, error } = await supabaseAdmin()
    .from('challenge_entries')
    .insert({
      challenge_id: challengeId,
      user_id: user.id,
      title: parsed.data.title,
      description: parsed.data.description,
      submission_url: parsed.data.submission_url,
      cover_image_key: parsed.data.cover_image_key,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'you already submitted an entry for this challenge' })
    }
    return res.status(500).json({ error: 'failed to submit entry' })
  }

  return res.status(201).json({ entry: data })
})

/**
 * POST /api/challenges/:id/vote — vote for an entry.
 * Body: { entry_id: string, direction: 'up' | 'down' }
 *
 * Simple voting: each authenticated user gets one vote per entry.
 * In a full implementation, we'd track votes per-user to prevent
 * double-voting. For now, this is a simple increment/decrement.
 */
challengeDetailRouter.post('/vote', async (req, res) => {
  const challengeId = (req.params as Record<string, string>).id

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  const body = req.body as { entry_id?: string; direction?: 'up' | 'down' } | undefined
  if (!body?.entry_id || !body.direction) {
    return res.status(400).json({ error: 'missing entry_id or direction' })
  }

  // Verify the entry belongs to this challenge.
  const { data: entry } = await supabaseAdmin()
    .from('challenge_entries')
    .select('id, votes')
    .eq('id', body.entry_id)
    .eq('challenge_id', challengeId)
    .single()

  if (!entry) return res.status(404).json({ error: 'entry not found' })

  const delta = body.direction === 'up' ? 1 : -1
  const newVotes = Math.max(0, entry.votes + delta)

  const { data, error: updateError } = await supabaseAdmin()
    .from('challenge_entries')
    .update({ votes: newVotes, updated_at: new Date().toISOString() })
    .eq('id', body.entry_id)
    .select()
    .single()

  if (updateError) return res.status(500).json({ error: 'failed to vote' })
  return res.json({ entry: data })
})
