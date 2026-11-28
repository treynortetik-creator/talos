// A test bridge must never reach the owner's real Chronos (on 2026-11-03 a test closed the live morning brief; a contract run
// that found the real one was asked about its jobs). When TALOS_TEST_ROOT is set, which only a test harness does, a Chronos is
// used only if everything it would read or write is under that folder, symlinks followed: its program, the HOME it is started
// with (Chronos reads `~`, and with no HOME Python falls back to the real passwd home) and its config. Anything else is refused
// and the scheduler stays off. A TALOS_TEST_ROOT that is set but empty, blank, relative or `/` refuses every Chronos: it fails
// closed. With no TALOS_TEST_ROOT at all nothing here changes the bridge: it is the production path.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { realFileSync } from '../real-file.ts'

/** The test root a harness set (possibly invalid: see isUnderRoot), or undefined when none is set, which is production. */
export function testRootOf(env: { testRoot?: string | undefined } | undefined, proc = process.env): string | undefined {
  return env?.testRoot ?? proc.TALOS_TEST_ROOT
}

/** The real path of `p`, or of its nearest existing parent with the rest appended (a path that does not exist yet). */
function realOrNear(p: string): string {
  const abs = resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realFileSync(cur), ...rest) // cur may be the program itself, a file: realFileSync, not realpath
      } catch {
        return abs
      }
    }
    const up = dirname(cur)
    if (up === cur) return abs
    rest.unshift(cur.slice(up.length + 1))
    cur = up
  }
}

/** A root that can mean something: absolute, not blank, and not the top of the file system. */
function usableRoot(root: string): boolean {
  if (root.trim() === '' || !isAbsolute(root)) return false
  return realOrNear(root) !== parse(resolve(root)).root
}

/** Is `p`, with symlinks resolved, inside `root` (also resolved)? An unusable root contains nothing. */
export function isUnderRoot(p: string, root: string): boolean {
  if (!usableRoot(root) || !isAbsolute(p)) return false
  const rel = relative(realOrNear(root), realOrNear(p))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Why a Chronos may not be used under `root`; null when it may. `home` is the HOME it is started with (undefined: none is passed,
 * so Python would use the real passwd home); `config` is CHRONOS_CONFIG, and with none named Chronos reads
 * `<home>/.config/chronos/config.json`, which must be under the root too.
 */
export function chronosRefusal(
  bin: string,
  root: string,
  o: { home?: string | undefined; config?: string | undefined } = {},
): string | null {
  if (!usableRoot(root)) return 'the test folder is not a usable absolute folder'
  if (!isUnderRoot(bin, root)) return 'the Chronos program is outside the test folder'
  if (!o.home) return 'no HOME is handed to Chronos, so it would use the real one'
  if (!isUnderRoot(o.home, root)) return 'the HOME handed to Chronos is outside the test folder'
  const config = o.config || join(o.home, '.config', 'chronos', 'config.json')
  if (!isUnderRoot(config, root)) return 'the Chronos config is outside the test folder'
  return null
}
