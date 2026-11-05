// What a lead's `attach` may not send: any file inside a protected root listed in the `.talos-lead` marker of the thread's
// session folder (docs/OPTION-C.md "Leads"). Compared after realpath, without regard to letter case, with `/private/tmp`
// and `/tmp` the same place. A marker that exists but cannot be read or understood refuses everything.
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { real } from '../guards/rules.ts'

const MARKER = '.talos-lead'
const fold = (p: string) => p.replace(/^\/private(?=\/)/, '').toLowerCase()
const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)

/** Why a thread session whose folder is `cwd` may not send `realPath` (already a real path), or undefined. */
export function leadAttachRefusal(cwd: string | undefined, realPath: string): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined
  const file = join(cwd, MARKER)
  try {
    lstatSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
      return undefined
    return `the lead marker (${MARKER}) cannot be read, so no file is sent; tell the owner`
  }
  let roots: string[]
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { protect?: unknown }
    if (
      !Array.isArray(m.protect) ||
      m.protect.length === 0 ||
      !m.protect.every((r) => typeof r === 'string' && isAbsolute(r))
    )
      throw new Error('no protect list')
    roots = m.protect as string[]
  } catch {
    return `the lead marker (${MARKER}) cannot be understood, so no file is sent; tell the owner`
  }
  const p = fold(realPath)
  for (const r of roots)
    if (within(p, fold(real(r))) || within(p, fold(r)))
      return 'a lead cannot send a file from a protected folder (see its marker)'
  return undefined
}
