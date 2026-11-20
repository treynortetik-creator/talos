// The on-disk half of a thread's folder, judged for what an agent's proposal writes: at propose time and again at apply (the
// disk may have changed since). The protocol judges the folder's text (config-propose.ts: the owner's home, ~/.claude, the Talos
// home) and the parent's reach as text; this adds what only the disk knows. Nothing here creates a folder.
//
// - The folder must exist and be a directory, and neither it nor the place a link leads to may be a refused root (the owner's
//   home itself, ~/.claude, the Talos data folder, the agent folder): `checkWorkerFolder`, the check every dedicated thread meets.
// - A thread SESSION'S sub-thread is held inside its parent's folder, compared as the disk resolves both, whole path segments
//   ("/a/site2" is not inside "/a/site"). Main follows the owner's own folder rules, so it has no containment check here.
// - A parent's folder moving under a sub-thread that has a folder of its own: refused unless that folder is still inside it.
import { type AgentConfigT, parentThread, subThreadsOf, type ThreadT } from '@talos-app/protocol'
import { checkWorkerFolder, realFolder as real, type WorkerRoots } from '../worker/patch-check.ts'

/** `child` is `parent` or below it, by whole path segments. */
const within = (child: string, parent: string): boolean => {
  const p = parent.replace(/\/+$/, '')
  return child === p || child.startsWith(`${p}/`)
}

/** Threads this write puts a folder on, or whose session starts: the folder as before, as after. */
function changedFolders(before: AgentConfigT, after: AgentConfigT): ThreadT[] {
  return after.threads.filter((t) => {
    if (t.archived) return false
    const was = before.threads.find((x) => x.id === t.id)
    const cwd = t.session_opts?.cwd
    if (!cwd) return false
    return !was || was.session_opts?.cwd !== cwd || (was.session !== t.session && t.session === 'dedicated')
  })
}

/**
 * Null when fine, else the reason (a sentence the agent can relay). `before` is the config as it is, `after` what the write
 * would leave; `scoped` is true when a thread's own session is the caller.
 */
export function folderIssue(
  before: AgentConfigT,
  after: AgentConfigT,
  roots: WorkerRoots,
  scoped: boolean,
): string | null {
  for (const t of changedFolders(before, after)) {
    const cwd = t.session_opts?.cwd as string
    const why = checkWorkerFolder(cwd, roots)
    if (why) return `thread "${t.id}": ${why}`
    const parent = parentThread(after, t.id)
    const theirs = parent?.session_opts?.cwd
    if (scoped && parent && theirs) {
      const mine = real(cwd)
      const outer = real(theirs)
      if (!mine || !outer || !within(mine, outer))
        return `thread "${t.id}": its folder must be inside "${parent.id}"'s folder (${theirs})`
    }
  }
  // a parent's folder moved: a sub-thread with a folder of its own must still be inside it
  for (const p of after.threads) {
    const was = before.threads.find((x) => x.id === p.id)
    const cwd = p.session_opts?.cwd
    if (!was || !cwd || was.session_opts?.cwd === cwd || p.archived) continue
    const outer = real(cwd)
    for (const c of subThreadsOf(after, p.id)) {
      const own = c.session_opts?.cwd
      if (c.archived || !own || p.parent_id) continue
      const inner = real(own)
      if (!outer || !inner || !within(inner, outer))
        return `${c.id} has its own folder outside the new one; the owner must move ${c.id} first.`
    }
  }
  return null
}

/** Is the real path of `child` strictly inside the real path of `parent`, by whole segments? A path that does not resolve is not. */
export function folderWithin(child: string, parent: string, strict = false): boolean {
  const c = real(child)
  const p = real(parent)
  return !!c && !!p && within(c, p) && !(strict && c === p)
}
