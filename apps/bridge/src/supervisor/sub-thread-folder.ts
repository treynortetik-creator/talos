// A sub-thread's own folder: strictly inside its parent's folder (made when missing), or one existing folder of its own outside
// it (c24c01f8, the Mac's SubThreadFolder). Moved out of worker-policy.ts, which re-exports it, for the size budget.
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

const isFolder = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const strictlyInside = (child: string, parent: string) => {
  const root = trimSlash(parent)
  return child !== root && child.startsWith(root === '/' ? '/' : `${root}/`)
}

const OUTSIDE = "the sub-thread's folder must be inside its parent thread's folder"

/**
 * The one exception to "inside" (the Mac's SubThreadFolder.ownFolder, c24c01f8): an absolute path with no `.` or `..` segment
 * that already exists as a folder outside the parent's, and is not the parent's own, is the sub-thread's own folder, used as it
 * is and never made (it does not get the parent's instructions). Not when it is written as a path under the parent, so a link
 * inside the parent that leads out stays an escape. Compared without case, as the Mac does: a case-folding mount can only make
 * this refuse more, never accept a folder the parent holds. The resolved folder, or null.
 */
export function ownSubThreadFolder(cwd: string, parentCwd: string): string | null {
  if (!cwd.startsWith('/') || !parentCwd.startsWith('/')) return null
  if (cwd.split('/').some((seg) => seg === '.' || seg === '..')) return null
  const parent = realOrNull(parentCwd)
  const child = realOrNull(cwd)
  if (!parent || !child || !isFolder(child)) return null
  const low = (p: string) => trimSlash(p).toLowerCase()
  const under = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)
  const written = low(cwd)
  if ([low(parentCwd), low(parent)].some((root) => under(written, root))) return null
  if (under(low(child), low(parent))) return null // inside (or the parent itself): the ordinary rule decides
  return child
}

/** Where a sub-thread's folder will be, made of what exists (resolved) and plain names, without making anything. */
function planSubThread(
  cwd: string,
  parentCwd: string,
): { parent: string; base: string; rest: string[]; target: string } | { refused: string } {
  if (!cwd.startsWith('/') || !parentCwd.startsWith('/')) return { refused: 'the folders must be absolute paths' }
  const parent = realOrNull(parentCwd)
  if (!parent || !isFolder(parent)) return { refused: "the parent thread's folder does not exist" }
  const parts = cwd.split('/').filter((p) => p !== '')
  let have = parts.length
  let base: string | null = null
  for (; have >= 0; have--) {
    base = realOrNull(`/${parts.slice(0, have).join('/')}`)
    if (base) break
  }
  if (!base || !isFolder(base)) return { refused: "the sub-thread's folder is not under a folder that exists" }
  const rest = parts.slice(have).filter((p) => p !== '.')
  if (rest.includes('..')) return { refused: OUTSIDE }
  const target = rest.length === 0 ? base : `${base === '/' ? '' : base}/${rest.join('/')}`
  if (!strictlyInside(target, parent)) return { refused: OUTSIDE }
  return { parent, base, rest, target }
}

/**
 * Where a sub-thread's folder will be once made (resolved), or null when it may not be made there. Makes nothing: a folder not
 * made yet is still the folder its next start launches in, so a change to one is a change of folder.
 */
export function subThreadTarget(cwd: string, parentCwd: string): string | null {
  const own = ownSubThreadFolder(cwd, parentCwd)
  if (own) return own
  const p = planSubThread(cwd, parentCwd)
  return 'refused' in p ? null : p.target
}

/**
 * The folder fence for a session that is running: 'outside' only on a firm verdict (the folder, as it resolves now, is not
 * strictly inside the parent's, or a path is not absolute), 'unknown' when a folder cannot be resolved for a moment (a
 * rename, a permission, a network mount: never a reason to stop a session that runs), else 'inside'.
 */
export function subThreadFence(cwd: string, parentCwd: string): 'inside' | 'outside' | 'unknown' {
  if (ownSubThreadFolder(cwd, parentCwd)) return 'inside' // its own folder, kept: nothing to park
  const p = planSubThread(cwd, parentCwd)
  if (!('refused' in p)) return 'inside'
  return p.refused === OUTSIDE || p.refused === 'the folders must be absolute paths' ? 'outside' : 'unknown'
}

/** Null when the sub-thread's folder is (or can be made) strictly inside its parent's. Makes nothing (the Mac's check). */
export function subThreadCheck(cwd: string, parentCwd: string): string | null {
  if (ownSubThreadFolder(cwd, parentCwd)) return null
  const p = planSubThread(cwd, parentCwd)
  return 'refused' in p ? p.refused : null
}

/** A sub-thread's folder exists, is a folder and is strictly inside its parent's, both resolved. Null = fine, else why not. */
export function subThreadProblem(cwd: string, parentCwd: string): string | null {
  if (!cwd.startsWith('/') || !parentCwd.startsWith('/')) return 'the folders must be absolute paths'
  const parent = realOrNull(parentCwd)
  if (!parent) return "the parent thread's folder does not exist"
  const child = realOrNull(cwd)
  if (!child) return "the sub-thread's folder does not exist"
  if (!isFolder(child)) return 'not a folder'
  if (ownSubThreadFolder(cwd, parentCwd)) return null
  return strictlyInside(child, parent) ? null : OUTSIDE
}

/**
 * A sub-thread's folder as it already is, for the update check's dry plan (nothing made): checked by the same rules as
 * prepareSubThreadFolder. A folder that is not there is refused, never assumed (the dry plan leaves such a session alone).
 */
export function existingSubThreadFolder(cwd: string, parentCwd: string): { folder: string } | { refused: string } {
  const own = ownSubThreadFolder(cwd, parentCwd)
  if (own) return { folder: own }
  const plan = planSubThread(cwd, parentCwd)
  if ('refused' in plan) return plan
  const made = realOrNull(plan.target)
  if (!made) return { refused: "the sub-thread's folder is not there" }
  if (!isFolder(made) || !strictlyInside(made, plan.parent)) return { refused: OUTSIDE }
  return { folder: made }
}

/**
 * A sub-thread's folder, resolved, made when missing: checked strictly inside the parent's BEFORE anything is made (a link or
 * `..` cannot make a folder outside it), and once more after.
 */
export function prepareSubThreadFolder(cwd: string, parentCwd: string): { folder: string } | { refused: string } {
  const own = ownSubThreadFolder(cwd, parentCwd)
  if (own) return { folder: own } // existing, outside: used as it is, nothing made
  const plan = planSubThread(cwd, parentCwd)
  if ('refused' in plan) return plan
  let path = plan.base
  for (const name of plan.rest) {
    path = `${path === '/' ? '' : path}/${name}`
    try {
      mkdirSync(path, { mode: 0o755 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { refused: "cannot make the sub-thread's folder" }
    }
    // after each step, what is there must be a real folder (never a link swapped in) still strictly inside the parent's
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(path)
    } catch {
      st = null
    }
    const real = realOrNull(path)
    if (!st?.isDirectory() || st.isSymbolicLink() || !real || !strictlyInside(real, plan.parent))
      return { refused: "cannot make the sub-thread's folder" }
  }
  const made = realOrNull(plan.target)
  if (!made || !isFolder(made) || !strictlyInside(made, plan.parent)) return { refused: OUTSIDE }
  return { folder: made }
}
