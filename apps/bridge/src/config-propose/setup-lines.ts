// The fixed sentences the owner reads after a thread's session or folder was set up (beside "Changed <field>: old → new. To undo:
// ..."): only fixed templates and values the protocol already validated (a thread's name, a folder, a model name) go in them.
// Usage: today's Claude-plan usage is not read on the bridge cheaply (it is the Mac app's status line), so it is left out.
import type { AgentConfigT, ConfigChange } from '@talos-app/protocol'

type Setup = { session?: unknown; session_opts?: { cwd?: unknown } }

/** One sentence for each thread that now has its own session, and one for each that now works in a folder. */
export function setupLines(changes: readonly ConfigChange[], config: AgentConfigT): string[] {
  const out: string[] = []
  const name = (id: string) => config.threads.find((t) => t.id === id)?.name ?? id
  for (const c of changes) {
    const made = /^threads\.([a-z][a-z0-9_]{0,31})$/.exec(c.path)
    const field = /^threads\.([a-z][a-z0-9_]{0,31})\.(session|session_opts\.cwd)$/.exec(c.path)
    const id = made?.[1] ?? field?.[1]
    if (!id) continue
    const v = made ? (c.new as Setup | null) : null
    if ((made && v?.session === 'dedicated') || (field?.[2] === 'session' && c.new === 'dedicated'))
      out.push(`${name(id)} now has its own session (uses your Claude plan).`)
    const cwd = made ? v?.session_opts?.cwd : field?.[2] === 'session_opts.cwd' ? c.new : undefined
    if (typeof cwd === 'string' && cwd) out.push(`${name(id)} now works in ${cwd}.`)
  }
  return out
}
