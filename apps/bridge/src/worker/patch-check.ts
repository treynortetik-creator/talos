// Mac-side checks for the Option C switch in a `config.patch` (docs/OPTION-C.md 9.2). They run on the EXACT config the
// bridge is about to write (after `resolveThreadsPatch`, the merge and the schema), never on a second, different merge.
// The schema already refused junk; this adds the rules only the Mac can check: which threads may be dedicated (scoped to
// the threads this change touches, so a switch-off is never refused), and that a thread's folder exists, is a real
// directory under $HOME, and does not resolve (through a symlink) into ~/.claude or $TALOS_APP_HOME. The desktop
// supervisor re-checks the folder before every start (a folder can be swapped for a symlink after this check).
import { realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AgentConfigT, checkWorkerCwd, dedicatedPatchIssue, FOLDER_WORDING } from '@talos-app/protocol'
import { folderDeps, folderRefusedRoots, underRefusedRoot } from '../folders/service.ts'

/**
 * `claudeDir` and `agentDir` are optional: the first defaults to `<home>/.claude`, the second to nothing (the agent folder is
 * refused only when the process knows it, from TALOS_AGENT_DIR, the same source the picker uses).
 */
export type WorkerRoots = { home: string; talosHome: string; claudeDir?: string; agentDir?: string }

export function defaultWorkerRoots(configPath: string): WorkerRoots {
  const d = folderDeps(dirname(configPath))
  return {
    home: d.home,
    talosHome: d.talosHome,
    claudeDir: d.claudeDir,
    ...(d.agentDir ? { agentDir: d.agentDir } : {}),
  }
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** The folders a thread may never work in: the picker's own list (`folderRefusedRoots`), never a second copy. */
function refusedFolder(path: string, roots: WorkerRoots): boolean {
  const list = folderRefusedRoots({
    home: roots.home,
    talosHome: roots.talosHome,
    claudeDir: roots.claudeDir ?? join(roots.home, '.claude'),
    ...(roots.agentDir ? { agentDir: roots.agentDir } : {}),
  })
  return underRefusedRoot(path, list, (r) => real(r) ?? r)
}

/** The on-disk folder check: null when fine, else a reason the app can show. */
export function checkWorkerFolder(cwd: string, roots: WorkerRoots): string | null {
  const lexical = checkWorkerCwd(cwd, roots)
  if (lexical) return lexical
  const resolved = real(cwd)
  if (!resolved) return 'that folder does not exist on your Mac'
  try {
    if (!statSync(resolved).isDirectory()) return 'that path is not a folder'
  } catch {
    return 'that folder does not exist on your Mac'
  }
  // compare like with like: the roots resolved too (macOS /var -> /private/var and the like)
  const resolvedRoots = {
    home: real(roots.home) ?? roots.home,
    talosHome: real(roots.talosHome) ?? roots.talosHome,
    claudeDir: real(join(roots.home, '.claude')),
  }
  const viaDisk = checkWorkerCwd(resolved, resolvedRoots)
  if (viaDisk) return viaDisk
  // the picker's own list: the folder as written, and as the disk spells it (a link that leads into a refused root is that root)
  if (refusedFolder(cwd, roots) || refusedFolder(resolved, roots)) return FOLDER_WORDING.refused
  return null
}

/**
 * Null when `next` may be written, else the reason to refuse. Only folders this change sets or changes on a thread that
 * is dedicated afterwards are checked on disk, so a folder that was deleted later doesn't block unrelated edits.
 */
export function optionCPatchIssue(current: AgentConfigT, next: AgentConfigT, roots: WorkerRoots): string | null {
  const issue = dedicatedPatchIssue(current, next)
  if (issue) return issue
  for (const t of next.threads) {
    const cwd = t.session_opts?.cwd
    if (!cwd || t.session !== 'dedicated') continue
    const was = current.threads.find((x) => x.id === t.id)
    if (was?.session === 'dedicated' && was.session_opts?.cwd === cwd) continue
    const why = checkWorkerFolder(cwd, roots)
    if (why) return `thread "${t.id}": ${why}`
  }
  return null
}
