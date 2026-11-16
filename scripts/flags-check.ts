// The kill-switch registry check (flags.json at the repo root; scripts/flags.test.ts runs it). A switch is read in one of a few
// shapes: the bridge's flag('NAME', ...), a bare compare of NAME to '0', '1', 'on' or 'off', a relay 0|1 (flag01) or allow|off
// enum, a /^(off|0...)$/.test(...NAME) and the Mac app's environment["NAME"] == "1". Each one read must have an entry; each
// entry must be read in the files it names. A new entry (not legacy) defaults off and names a test of its off path, tagged
// `flag:NAME` in the test's title. Legacy entries predate the registry: they keep their real default and say why.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export type Flag = {
  name: string
  surface: 'bridge' | 'relay' | 'mac'
  /** `off`, `on`, or the value it has unset (e.g. `auto`). */
  default: string
  /** The loadEnv key it lands on, when there is one (the test checks its default there). */
  key?: string
  /** The value loadEnv gives it unset, when that is not the default's own (e.g. the relay's raw '0'). */
  unset?: unknown
  /** Files that read it, from the repo root. */
  readers: string[]
  /** `flag:NAME`, in the title of the test that shows its off path. */
  test?: string
  /** Why it is not held to the new-switch rules (its real default, a precedence of its own). */
  legacy?: string
  owner: string
  added: string
  removeBy: string | null
}

const SOURCES: Array<[string, RegExp]> = [
  ['apps/bridge/src', /\.ts$/],
  ['apps/relay/src', /\.ts$/],
  ['apps/desktop/Sources', /\.swift$/],
]
const TEST_ROOTS = ['apps', 'packages', 'scripts', 'e2e']
const IS_TEST = /\.(test|spec)\.tsx?$|\/Tests\/.*\.swift$/ // the Mac app's tests are under apps/desktop/Tests/
const READS = [
  /\bflag\(\s*'([A-Z][A-Z0-9_]*)'/g,
  /\.([A-Z][A-Z0-9_]*)\s*\)?\s*[!=]==\s*'(?:0|1|on|off)'/g,
  /\b([A-Z][A-Z0-9_]*):\s*(?:flag01\b|z\s*\.enum\(\s*\[\s*'0'\s*,\s*'1'\s*\]|z\s*\.enum\(\s*\[[^\]]*'off'[^\]]*\])/g,
  /\/\^\(?(?:off|0)\|[^/]*\/i?\.test\([^)]*?\.([A-Z][A-Z0-9_]*)/g,
  /environment\[\s*"([A-Z][A-Z0-9_]*)"\s*\]\s*[!=]=\s*"(?:0|1|on|off)"/g,
]

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, keep, out)
    else if (keep(p)) out.push(p)
  }
  return out
}

export function readRegistry(root: string): Flag[] {
  return (JSON.parse(readFileSync(join(root, 'flags.json'), 'utf8')) as { flags: Flag[] }).flags
}

/** Every switch read in the sources: name -> the files (from the root) that read it. */
function findReads(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const [dir, ext] of SOURCES)
    for (const file of walk(join(root, dir), (p) => ext.test(p) && !IS_TEST.test(p))) {
      const text = readFileSync(file, 'utf8')
      for (const re of READS)
        for (const m of text.matchAll(re)) {
          const at = relative(root, file)
          const list = found.get(m[1] as string) ?? []
          if (!list.includes(at)) list.push(at)
          found.set(m[1] as string, list)
        }
    }
  return found
}

/** Every problem, one line each; empty when the registry and the code agree. */
export function checkFlags(root: string): string[] {
  const flags = readRegistry(root)
  const problems: string[] = []
  const seen = new Set<string>()
  let tests: string | undefined
  const testText = () => {
    tests ??= TEST_ROOTS.flatMap((d) => walk(join(root, d), (p) => IS_TEST.test(p)))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    return tests
  }
  for (const f of flags) {
    const n = f.name
    if (seen.has(n)) problems.push(`${n}: listed twice`)
    seen.add(n)
    if (!['bridge', 'relay', 'mac'].includes(f.surface)) problems.push(`${n}: surface must be bridge, relay or mac`)
    if (!f.readers?.length) problems.push(`${n}: no readers`)
    for (const r of f.readers ?? []) {
      const p = join(root, r)
      if (!existsSync(p) || !readFileSync(p, 'utf8').includes(n)) problems.push(`${n}: ${r} does not read it`)
    }
    if (f.legacy) continue
    if (f.default !== 'off')
      problems.push(`${n}: a new switch defaults off (unset is today's behaviour), not ${f.default}`)
    if (f.test !== `flag:${n}` || !testText().includes(`flag:${n}`)) problems.push(`${n}: no test is named flag:${n}`)
  }
  for (const [n, files] of findReads(root))
    if (!seen.has(n)) problems.push(`${n} is read in ${files.join(', ')} but has no entry in flags.json`)
  return problems
}
