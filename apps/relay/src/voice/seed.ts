// `input` for `openai.live.create` (spec 6.2 step 2): up to 20 text items built only from the owner's and the agent's own
// messages. Hook rows, events, cards, call records and the inbox thread never reach the voice model.
import type { MessageT } from '@talos-app/protocol'
import type { InitialItem } from 'openai/resources/live/live'

export const SEED_MAX_ITEMS = 20
export const SEED_MAX_CHARS = 1000

export function eligibleForSeed(m: MessageT, threadId: string): boolean {
  if (m.thread_id !== threadId || threadId === 'inbox') return false
  if (m.author !== 'owner' && m.author !== 'agent') return false
  if (m.via === 'hook' || m.kind === 'event') return false
  // `voice_turn` rows (earlier calls) are authored 'owner' by the relay, never signed by a device: they stay out of the seed.
  if (m.kind !== 'text' && m.kind !== 'voice_note') return false
  return Boolean((m.kind === 'voice_note' ? m.transcript?.text : m.text)?.trim())
}

export function buildSeed(
  messages: readonly MessageT[],
  thread: { id: string; voice_context: 'none' | 'recent' },
): InitialItem[] {
  if (thread.voice_context === 'none' || thread.id === 'inbox') return []
  return messages
    .filter((m) => eligibleForSeed(m, thread.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-SEED_MAX_ITEMS)
    .map((m): InitialItem => {
      const text = ((m.kind === 'voice_note' ? m.transcript?.text : m.text) ?? '').trim().slice(0, SEED_MAX_CHARS)
      return m.author === 'owner'
        ? { role: 'user', type: 'message', content: [{ type: 'input_text', text }] }
        : { role: 'assistant', type: 'message', content: [{ type: 'output_text', text }] }
    })
}
