// Whether the agent in the agent folder (TALOS_AGENT_DIR) has never been set up: the one case where pairing the first
// device starts the setup interview by itself (device.pinned `first`). Stricter than the kit's session-start hook
// (kit/hooks/_talos_session.py, onboarding_block and _onb_old_agent), which owns the interview's state. Fresh only when:
//   - CLAUDE.md is there and untuned (the shipped placeholder or the default render): the folder exists, nobody made it
//     their own;
//   - no wave of wiki/_onboarding-progress.md reads `done`;
//   - .agent-state/onboarding.json is missing, or says not_offered, or `later` at wave 1 (the hook writes `later` itself
//     the moment it first offers). in_progress, declined and done mean someone chose.
// Anything unreadable, odd or unknown is NOT fresh: the interview never starts for an agent this cannot vouch for.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 65_536
/** The kit's default persona line (kit/hooks/_talos_session.py `_ONB_DEFAULT_PERSONA`): in a CLAUDE.md nobody tuned. */
export const DEFAULT_PERSONA = 'A direct, capable assistant that remembers what the owner tells it.'
const PLACEHOLDER = '<!-- talos:placeholder -->'

type Read = { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'odd' }

/** A regular file, under the cap, opened without following a link or blocking on a pipe. */
function readSmall(path: string): Read {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'odd' }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_BYTES) return { kind: 'odd' }
    const buf = Buffer.alloc(st.size)
    let at = 0
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at)
      if (n === 0) break
      at += n
    }
    return { kind: 'text', text: buf.subarray(0, at).toString('utf8') }
  } catch {
    return { kind: 'odd' }
  } finally {
    closeSync(fd)
  }
}

function wavesDone(progress: string): number {
  const done = new Set<string>()
  for (const m of progress.matchAll(/^\|\s*([1-8])\s*\|[^|\n]*\|\s*done\s*\|/gm)) done.add(m[1] as string)
  return done.size
}

/** True only for an agent folder that shows no setup at all. */
export function agentNeverSetUp(agentDir: string | undefined): boolean {
  if (!agentDir) return false
  // the folder is there and holds the CLAUDE.md the installer renders: a mistyped or stale TALOS_AGENT_DIR is not fresh
  const claude = readSmall(join(agentDir, 'CLAUDE.md'))
  if (claude.kind !== 'text') return false
  const untuned = claude.text.includes(PLACEHOLDER) || claude.text.includes(DEFAULT_PERSONA)
  if (!untuned) return false // someone made this agent their own
  const progress = readSmall(join(agentDir, 'wiki', '_onboarding-progress.md'))
  if (progress.kind === 'odd') return false
  if (progress.kind === 'text' && wavesDone(progress.text) > 0) return false
  const state = readSmall(join(agentDir, '.agent-state', 'onboarding.json'))
  if (state.kind === 'odd') return false
  if (state.kind === 'missing') return true // the kit's "old agent" rule is the untuned CLAUDE.md and no wave above
  let d: unknown
  try {
    d = JSON.parse(state.text)
  } catch {
    return false
  }
  if (typeof d !== 'object' || d === null) return false
  const { state: s, wave } = d as { state?: unknown; wave?: unknown }
  // `later` is what the hook writes the moment it first offers; with a wave past the first, someone answered
  return (s === 'not_offered' || s === 'later') && (wave === undefined || wave === 1)
}
