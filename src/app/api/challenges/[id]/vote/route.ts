import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { json, isOptions, optionsOk } from '@/lib/http'

export const runtime = 'nodejs'

/**
 * POST /api/challenges/[id]/vote — vote for an entry.
 * Body: { entry_id: string, direction: 'up' | 'down' }
 *
 * Simple voting: each authenticated user gets one vote per entry.
 * In a full implementation, we'd track votes per-user to prevent
 * double-voting. For now, this is a simple increment/decrement.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOptions(req)) return optionsOk()
  const { id: challengeId } = await params

  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const { data: { user }, error } = await supabaseAdmin().auth.getUser(auth)
  if (error || !user) return json({ error: 'unauthorized' }, 401)

  let body: { entry_id?: string; direction?: 'up' | 'down' }
  try { body = await req.json() } catch { return json({ error: 'invalid json' }, 400) }

  if (!body.entry_id || !body.direction) {
    return json({ error: 'missing entry_id or direction' }, 400)
  }

  // Verify the entry belongs to this challenge.
  const { data: entry } = await supabaseAdmin()
    .from('challenge_entries')
    .select('id, votes')
    .eq('id', body.entry_id)
    .eq('challenge_id', challengeId)
    .single()

  if (!entry) return json({ error: 'entry not found' }, 404)

  const delta = body.direction === 'up' ? 1 : -1
  const newVotes = Math.max(0, entry.votes + delta)

  const { data, error: updateError } = await supabaseAdmin()
    .from('challenge_entries')
    .update({ votes: newVotes, updated_at: new Date().toISOString() })
    .eq('id', body.entry_id)
    .select()
    .single()

  if (updateError) return json({ error: 'failed to vote' }, 500)
  return json({ entry: data })
}
