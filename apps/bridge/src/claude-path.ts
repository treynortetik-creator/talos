// Where the installed `claude` is: the first executable file named `claude` on PATH, the same lookup the live launch line uses.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** `claude` on PATH, the same lookup the live launch line uses. */
export function resolveClaude(
  pathVar: string | undefined,
  isExec: (p: string) => boolean = defaultIsExec,
): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, 'claude')
    if (isExec(p)) return p
  }
  return undefined
}

function defaultIsExec(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}
