// scripts/test-delta.ts: how many test cases a change adds and removes against its base, counted from the diff (declarations, never
// timings, so the number is the same on every machine), by kind: unit (vitest and bun), e2e (Playwright and the browser tests:
// each file costs CI seconds of module loading, so a NEW one is listed by name) and swift (@Test and XCTest's func test...).
//   node scripts/test-delta.ts --base <ref> [--root <dir>]
// One line, for the gate's output and the reviewer's brief. Information only: it always exits 0 (2 for no --base), and it is no target:
// deleting a cheap test earns nothing, and adding the test a change needs costs nothing here.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isTestFile } from './timing-lint.ts'

export type Kind = 'unit' | 'e2e' | 'swift'
export interface Count {
  added: number
  removed: number
}
export interface Delta extends Record<Kind, Count> {
  newE2eFiles: string[]
}
export interface FileDiff {
  file: string
  added: string[]
  removed: string[]
  isNew: boolean
}

const KINDS: Kind[] = ['unit', 'e2e', 'swift']
// it(, test(, and their modifiers (it.skip, test.only, it.each([...])(, test.skipIf(cond)(), when the name or the end of the line
// follows: `test.skip(cond, 'why')` inside a body, `test.step(` and `describe(` are not test cases
const JS_CASE =
  /^\s*(?:it|test)(?:\.(?:only|skip|todo|fails|concurrent|sequential|failing))*(?:\.(?:skipIf|runIf|each)\(.*?\))?\s*\(\s*(?:['"`]|$)/
const SWIFT_ATTR = /^\s*@Test\b/
const SWIFT_FUNC =
  /^\s*(?:(?:public|internal|private|fileprivate|final|override|static|nonisolated)\s+)*func\s+test\w*\s*\(/

/** The kind of a test file, or undefined for a file that is not one. */
export function kindOf(file: string): Kind | undefined {
  if (!isTestFile(file)) return undefined
  if (file.endsWith('.swift')) return 'swift'
  if (/^e2e\//.test(file) || /\.spec\.tsx?$/.test(file) || /\/test-browser\//.test(file)) return 'e2e'
  return 'unit'
}

/** The test cases declared in these lines (each line of the diff on one side, in order): one per declaration. */
export function countDeclarations(file: string, lines: string[]): number {
  const swift = file.endsWith('.swift')
  let n = 0
  let afterAttr = false // the line before was an @Test line: `@Test` then `func testX()` is one test case
  for (const l of lines) {
    if (swift) {
      if (SWIFT_ATTR.test(l)) {
        n++
        afterAttr = true
        continue
      }
      if (SWIFT_FUNC.test(l) && !afterAttr) n++
      afterAttr = false
    } else if (JS_CASE.test(l)) n++
  }
  return n
}

/** The files of a `git diff -U0` text, with the lines each side changed. */
export function parseDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  let cur: FileDiff | undefined
  let inHunk = false
  let from = ''
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      cur = undefined
      inHunk = false
      from = ''
    } else if (!inHunk && l.startsWith('new file mode')) {
      from = '/dev/null'
    } else if (!inHunk && l.startsWith('--- ')) {
      from = l.slice(4)
    } else if (!inHunk && l.startsWith('+++ ')) {
      const to = l.slice(4)
      const file = to === '/dev/null' ? from.replace(/^a\//, '') : to.replace(/^b\//, '')
      cur = { file, added: [], removed: [], isNew: from === '/dev/null' }
      out.push(cur)
    } else if (l.startsWith('@@')) inHunk = true
    else if (cur && inHunk) {
      if (l.startsWith('+')) cur.added.push(l.slice(1))
      else if (l.startsWith('-')) cur.removed.push(l.slice(1))
    }
  }
  return out
}

export function deltaOf(files: FileDiff[]): Delta {
  const d: Delta = {
    unit: { added: 0, removed: 0 },
    e2e: { added: 0, removed: 0 },
    swift: { added: 0, removed: 0 },
    newE2eFiles: [],
  }
  for (const f of files) {
    const k = kindOf(f.file)
    if (!k) continue
    d[k].added += countDeclarations(f.file, f.added)
    d[k].removed += countDeclarations(f.file, f.removed)
    if (k === 'e2e' && f.isNew) d.newE2eFiles.push(f.file)
  }
  return d
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

export function line(d: Delta): string {
  const added = KINDS.reduce((s, k) => s + d[k].added, 0)
  const removed = KINDS.reduce((s, k) => s + d[k].removed, 0)
  const split = KINDS.map((k) => `${k} +${d[k].added} -${d[k].removed}`).join(', ')
  const files = d.newE2eFiles
  const named = files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '')
  const newFiles = files.length > 0 ? `; new e2e files: ${named} (each costs CI seconds of module loading)` : ''
  return `test-delta: net ${added === removed ? '0' : signed(added - removed)} (added ${added}, removed ${removed}): ${split}${newFiles}`
}

export function main(argv: string[]): number {
  let base = ''
  let root = process.cwd()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i] ?? ''
    else if (argv[i] === '--root') root = argv[++i] ?? root
  }
  if (!base) {
    console.error('test-delta: --base <ref> is needed')
    return 2
  }
  try {
    const diff = execFileSync('git', ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(line(deltaOf(parseDiff(diff))))
  } catch (e) {
    console.error(`test-delta: no count (${(e as Error).message.split('\n')[0]})`) // information only: never a failure
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
