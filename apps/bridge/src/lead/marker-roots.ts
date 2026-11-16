// What a lead's `attach` may not send: any file inside a protected root listed in ANY `.talos-lead` marker at or above the
// thread's session folder (docs/OPTION-C.md "Leads"). All of them, not the nearest: a sub-thread's lead can write in its own
// folder, so a marker it plants there must never shed its parent lead's roots; a nearer marker can only add to them. Compared
// after realpath, without regard to letter case, with `/private/tmp` and `/tmp` the same place. A marker that exists but cannot
// be read or understood refuses everything.
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { real } from '../guards/rules.ts'

const MARKER = '.talos-lead'
const fold = (p: string) => p.replace(/^\/private(?=\/)/, '').toLowerCase()
const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)

/** The protect list of one marker, or a refusal when it exists but cannot be read or understood. */
function rootsOf(file: string): string[] | { refusal: string } {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { protect?: unknown }
    if (
      !Array.isArray(m.protect) ||
      m.protect.length === 0 ||
      !m.protect.every((r) => typeof r === 'string' && isAbsolute(r))
    )
      throw new Error('no protect list')
    return m.protect as string[]
  } catch {
    return { refusal: `the lead marker (${MARKER}) cannot be understood, so no file is sent; tell the owner` }
  }
}

/**
 * Why a thread session whose folder is `cwd` may not send `realPath` (already a real path), or undefined. `parentCwd` is its
 * parent thread's folder: a sub-thread that keeps its own folder outside its parent's is bound by the parent lead's markers too, so
 * both chains are read and any refusal refuses.
 */
export function leadAttachRefusal(cwd: string | undefined, realPath: string, parentCwd?: string): string | undefined {
  // every marker at or above each folder, as the CLI fence looks for them
  const roots: string[] = []
  let found = false
  for (const start of [cwd, parentCwd]) {
    if (!start || !isAbsolute(start)) continue
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      const at = join(dir, MARKER)
      let exists = false
      try {
        lstatSync(at)
        exists = true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
          return `the lead marker (${MARKER}) cannot be read, so no file is sent; tell the owner`
      }
      if (exists) {
        const r = rootsOf(at)
        if (!Array.isArray(r)) return r.refusal
        roots.push(...r)
        found = true
      }
      if (dirname(dir) === dir) break
    }
  }
  if (!found) return undefined
  const p = fold(realPath)
  for (const r of roots)
    if (within(p, fold(real(r))) || within(p, fold(r)))
      return 'a lead cannot send a file from a protected folder (see its marker)'
  return undefined
}
