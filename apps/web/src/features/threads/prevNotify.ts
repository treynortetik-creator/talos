// Mute turns a thread's notifications off; Unmute should give back what it had (`all` or `needs_you`), not always `all`.
// The thread file keeps one value, so the earlier one is remembered on this device. A thread muted somewhere else, or before
// this device remembered, comes back as `all`.
import { ownValue } from '@talos-app/protocol'

type Level = 'all' | 'needs_you'
const KEY = 'talos.notifyBeforeMute'
const mem = new Map<string, Level>()

const read = (): Record<string, Level> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, Level>) : {}
  } catch {
    return Object.fromEntries(mem)
  }
}

/** Remember what a thread was set to as it is muted. */
export function rememberNotify(threadId: string, level: 'all' | 'needs_you' | 'off'): void {
  if (level === 'off') return
  mem.set(threadId, level)
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [threadId]: level }))
  } catch {
    // private window or blocked storage: the in-memory copy still serves this session
  }
}

/** What Unmute restores. */
export function notifyAfterUnmute(threadId: string): Level {
  const v = mem.get(threadId) ?? ownValue(read(), threadId)
  return v === 'needs_you' ? 'needs_you' : 'all'
}
