// check's per-test file (docs/CI-MACHINES.md, "check on Titan"): every test check ran, from Vitest and from the bridge's bun
// files, as one sorted TSV, so a shadow run of check on Titan compares with Lemnos's own check test by test, skips included.
//
//   bun scripts/ci-test-results.ts <results dir> <out file> <sha> <machine> [<part>:<machine> ...]
//
// <results dir> holds vitest.tsv (scripts/ci-test-results-vitest.ts) and bun/ (apps/bridge/scripts/test-parallel.ts with
// TALOS_TEST_JUNIT_DIR: <name>.xml per file, <name>.first.xml for a file's first run when it was retried, <name>.crashed holding
// the path of a file that ended without a report). The out file:
//
//   # talos-check-tests v1 <sha> <machine>
//   [# parts elsewhere: <part>:<machine> ...]  check's parts another machine ran (CI_REMOTE_PARTS): their tests are not here
//   [# no bun results]                      the commit's runner writes none (older than this file), or no bun file ran
//   <suite>\t<file>\t<name>\t<state>        suite vitest|bun; file repo-relative; name "describe > ... > test"; sorted
//
// state: pass, fail, skip, todo, flaky (failed, then passed on the retry). A file that crashed or timed out before reporting is
// one line with name "*" and state fail. Two tests of one name in one file are told apart by order: the second is "<name> #2".
// Sorted by bytes, as LC_ALL=C sort does, so a `join` (LC_ALL=C) of two of these files works as it is. It prints the summary line, "check-tests: <n> tests, ...", for the job's log.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Row = [suite: string, file: string, name: string, state: string]

const BRIDGE = 'apps/bridge/'
const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ')
const xmlText = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? xmlText(m[1]) : undefined
}

/** bun's junit report of one file: one row per test case, its describe path joined with " > ". */
export function parseJunit(xml: string, prefix = BRIDGE): Row[] {
  const rows: Row[] = []
  const suites: { name: string; file?: string }[] = []
  let open: { file: string; name: string; state: string } | undefined
  for (const m of xml.matchAll(/<(\/?)(testsuites|testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, rest, self] = m
    if (tag === 'testsuites') continue
    if (tag === 'testsuite') {
      if (close) suites.pop()
      else if (!self) suites.push({ name: attr(rest, 'name') ?? '', file: attr(rest, 'file') })
      continue
    }
    if (tag === 'testcase') {
      if (close) {
        if (open) rows.push(['bun', prefix + open.file, open.name, open.state])
        open = undefined
        continue
      }
      // the outermost suite is the file itself; the ones inside it are its describes
      const path = suites.slice(1).map((s) => s.name)
      const file = attr(rest, 'file') ?? suites[0]?.file ?? suites[0]?.name ?? '?'
      const name = clean([...path, attr(rest, 'name') ?? ''].join(' > '))
      if (self) rows.push(['bun', prefix + file, name, 'pass'])
      else open = { file, name, state: 'pass' }
      continue
    }
    if (!open || close) continue
    if (tag === 'skipped') open.state = attr(rest, 'message') === 'TODO' ? 'todo' : 'skip'
    else open.state = 'fail' // failure, error
  }
  return rows
}

/** The bun rows of a junit dir: a retried file's tests that failed on the first run and pass now are flaky. */
/** The second and later tests of one name in one file (in the order they ran) get " #2", " #3": every key is unique. */
export function numbered(rows: Row[]): Row[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const k = `${r[0]}\t${r[1]}\t${r[2]}`
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n === 1 ? r : [r[0], r[1], `${r[2]} #${n}`, r[3]]
  })
}

export function bunRows(dir: string, prefix = BRIDGE): { rows: Row[]; any: boolean } {
  if (!existsSync(dir)) return { rows: [], any: false }
  const names = readdirSync(dir)
  const rows: Row[] = []
  const reported = new Set<string>()
  for (const f of names) {
    if (!f.endsWith('.xml') || f.endsWith('.first.xml')) continue
    const now = numbered(parseJunit(readFileSync(join(dir, f), 'utf8'), prefix))
    const first = f.replace(/\.xml$/, '.first.xml')
    const failedFirst = new Set<string>()
    if (names.includes(first))
      for (const r of numbered(parseJunit(readFileSync(join(dir, first), 'utf8'), prefix)))
        if (r[3] === 'fail') failedFirst.add(`${r[1]}\t${r[2]}`)
    for (const r of now) {
      if (r[3] === 'pass' && failedFirst.has(`${r[1]}\t${r[2]}`)) r[3] = 'flaky'
      rows.push(r)
    }
    reported.add(f.replace(/\.xml$/, ''))
  }
  // a file that ended without a report (crashed, killed at the file limit) on its last run: one "*" fail line
  for (const f of names) {
    if (!f.endsWith('.crashed') || reported.has(f.replace(/\.crashed$/, ''))) continue
    rows.push(['bun', prefix + readFileSync(join(dir, f), 'utf8').trim(), '*', 'fail'])
  }
  return { rows, any: names.some((f) => f.endsWith('.xml') || f.endsWith('.crashed')) }
}

export function vitestRows(file: string): Row[] {
  if (!existsSync(file)) return []
  return numbered(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t') as Row),
  )
}

const key = (r: Row) => r.join('\t')
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))))
}

export function summary(rows: Row[]): string {
  const n = (s: string) => rows.filter((r) => r[3] === s).length
  return `check-tests: ${rows.length} tests, ${n('pass')} pass, ${n('fail')} fail, ${n('skip')} skip, ${n('todo')} todo, ${n('flaky')} flaky`
}

export function build(
  dir: string,
  sha: string,
  machine: string,
  elsewhere: string[] = [],
): { text: string; rows: Row[] } {
  const bun = bunRows(join(dir, 'bun'))
  const rows = sortRows([...vitestRows(join(dir, 'vitest.tsv')), ...bun.rows])
  const head = [
    `# talos-check-tests v1 ${sha} ${machine}`,
    ...(elsewhere.length ? [`# parts elsewhere: ${elsewhere.join(' ')}`] : []),
    ...(bun.any ? [] : ['# no bun results']),
  ]
  return { text: `${[...head, ...rows.map(key)].join('\n')}\n`, rows }
}

function main(argv: string[]): number {
  const [dir, out, sha, machine, ...elsewhere] = argv
  if (!dir || !out || !sha || !machine) {
    console.error('usage: ci-test-results.ts <results dir> <out file> <sha> <machine> [<part>:<machine> ...]')
    return 64
  }
  const { text, rows } = build(dir, sha, machine, elsewhere)
  writeFileSync(out, text)
  console.log(summary(rows))
  return 0
}

if ((import.meta as { main?: boolean }).main) process.exit(main(process.argv.slice(2)))
