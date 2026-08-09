import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

const submitSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  submission_url: z.string().url().max(500).optional(),
  cover_image_key: z.string().max(500).optional(),
})

async function requireUser(req: Request) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return null
  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return null
  return user
}

/**
 * GET /api/challenges/[id]/entries — list entries for a challenge.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id } = await params

  const { data, error } = await supabaseAdmin()
    .from('challenge_entries')
    .select('*, users(id, display_name, stellar_address)')
    .eq('challenge_id', id)
    .order('votes', { ascending: false })

  if (error) return json({ error: 'failed to fetch entries' }, 500)
  return json({ entries: data })
}

/**
 * POST /api/challenges/[id]/entries — submit an entry (authenticated).
 * One entry per user per challenge.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: challengeId } = await params

  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  // Verify challenge exists and is active.
  const { data: challenge } = await supabaseAdmin()
    .from('challenges')
    .select('id, status, ends_at')
    .eq('id', challengeId)
    .single()

  if (!challenge) return json({ error: 'challenge not found' }, 404)
  if (challenge.status !== 'active') {
    return json({ error: 'challenge is not accepting entries' }, 400)
  }
  if (new Date() > new Date(challenge.ends_at)) {
    return json({ error: 'challenge has ended' }, 400)
  }

  // Ensure user has a profile row.
  const { data: userProfile } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single()

  if (!userProfile) return json({ error: 'user profile not found' }, 400)

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  const parsed = submitSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'validation failed', details: parsed.error.flatten() }, 400)
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
      return json({ error: 'you already submitted an entry for this challenge' }, 409)
    }
    return json({ error: 'failed to submit entry' }, 500)
  }

  return json({ entry: data }, 201)
}
