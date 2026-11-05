// Mac-side checks for the Option C switch in a `config.patch` (docs/OPTION-C.md 9.2). They run on the EXACT config the
// bridge is about to write (after `resolveThreadsPatch`, the merge and the schema), never on a second, different merge.
// The schema already refused junk; this adds the rules only the Mac can check: which threads may be dedicated (scoped to
// the threads this change touches, so a switch-off is never refused), and that a thread's folder exists, is a real
// directory under $HOME, and does not resolve (through a symlink) into ~/.claude or $TALOS_APP_HOME. The desktop
// supervisor re-checks the folder before every start (a folder can be swapped for a symlink after this check).
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type AgentConfigT, checkWorkerCwd, dedicatedPatchIssue } from '@talos-app/protocol'

export type WorkerRoots = { home: string; talosHome: string }

export function defaultWorkerRoots(configPath: string): WorkerRoots {
  return { home: homedir(), talosHome: dirname(configPath) }
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
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
  return checkWorkerCwd(resolved, resolvedRoots)
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
