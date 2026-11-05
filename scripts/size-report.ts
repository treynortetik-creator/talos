// The one place that decides what a "line" is and which files count, so every size number in this repo agrees.
//
//   node scripts/size-report.ts            print the report
//   node scripts/size-report.ts --json     the same numbers as JSON (what scripts/size-budget.test.ts reads)
//
// A line is a physical line of a tracked file: each "\n" ends one, and a last line with no "\n" counts too. Blank lines and
// comments count. Nothing is stripped, so the number matches `wc -l` and what an editor shows.
//
// Which files: everything git tracks (`git ls-files`; a copy with no .git walks the folder instead). A file that is not added yet is
// not counted, and neither is build output a tool writes into the tree. Minus lockfiles, binaries, vendored code (`third_party`),
// art (the root `assets` folder) and captured fixtures. What is left is sorted into a group by path:
//   core      production code in apps/web, apps/bridge, apps/relay, packages/protocol, packages/integrations
//   desktop   the Swift Mac app (apps/desktop); mobile is the Capacitor shell (apps/mobile)
//   testkit   packages/testkit, the fakes and contract suites. Reported on its own line, never counted as core.
//   plugin    plugins/
//   tooling   scripts/, e2e harness, root config
//   tests     a package's test folder (`<apps|packages|plugins>/<name>/test`, `tests`, `test-contract`), `e2e/tests`, the Swift
//             `Tests` folders, or any file named *.test.* / *.spec.*. A production path that merely contains one of those words
//             (a `review-queue.tsx` screen, `SelfTest.swift`) stays production.
//   docs      Markdown
// A function is a TypeScript function, method, constructor, accessor or arrow function; its size is the lines from the
// first line of its declaration to its closing brace. A function with no name of its own (a callback passed as an
// argument) is not counted: its size is part of the function around it. The exception is a module-level function that is the
// value of an export or a variable (`export default () => {}`, `const A = memo((p) => ...)`): it is named after that export or
// variable. Only TypeScript (.ts, .tsx, .mts) is measured for functions; the other languages get file sizes only.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SOURCE_EXT = /\.(ts|tsx|mts|mjs|js|swift|sh|py)$/
const TS_EXT = /\.(ts|tsx|mts)$/
const SKIP_PATH =
  /(^|\/)(node_modules|dist|\.dev)\/|^(third_party|assets)\/|^packages\/[^/]+\/fixtures\/|^(apps|packages|plugins)\/[^/]+\/test\/fixtures\/|(^|\/)pnpm-lock\.yaml$|\.(png|jpe?g|gif|webp|ico|woff2?|mp[34]|m4a|webm|mov|pdf|zip|snap|blend)$/
const TEST_PATH =
  /^(apps|packages|plugins)\/[^/]+\/(test|tests|test-contract)\/|^e2e\/tests\/|^apps\/desktop\/Tests\/|^apps\/mobile\/ios\/[^/]+\/Tests\/|(^|\/)__tests__\/|\.(test|spec)\.[a-z]+$/

export type Group = 'core' | 'desktop' | 'mobile' | 'testkit' | 'plugin' | 'tooling' | 'tests' | 'docs' | 'other'

/** Number of physical lines in a text. */
export function countLines(text: string): number {
  if (text === '') return 0
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n : n + 1
}

export function groupOf(path: string): Group {
  if (/\.md$/.test(path)) return 'docs'
  if (TEST_PATH.test(path)) return 'tests'
  if (path.startsWith('apps/desktop/')) return 'desktop'
  if (path.startsWith('apps/mobile/')) return 'mobile'
  if (path.startsWith('packages/testkit/')) return 'testkit'
  if (path.startsWith('plugins/')) return 'plugin'
  if (/^(apps\/(web|bridge|relay)|packages\/(protocol|integrations))\//.test(path)) return 'core'
  if (path.startsWith('scripts/') || path.startsWith('e2e/') || !path.includes('/')) return 'tooling'
  return 'other'
}

function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push(relative(base, full).split(sep).join('/'))
  }
}

/** Repo-relative paths of the files that count, sorted. */
export function listFiles(root: string = ROOT): string[] {
  let all: string[]
  if (existsSync(join(root, '.git'))) {
    // -z: a name with a newline or a quote in it still comes back whole. A deleted-but-listed file is skipped below.
    // Tracked files only: an untracked file is whatever a tool left in the tree (a build folder, a scratch copy), not the PR.
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
    all = [...new Set(out.split('\0').filter(Boolean))]
  } else {
    all = []
    walk(root, root, all)
  }
  return all.filter((p) => !SKIP_PATH.test(p) && existsSync(join(root, p))).sort()
}

export interface FileSize {
  path: string
  lines: number
  group: Group
}

/** Every counted source file or Markdown file with its line count. */
export function measureFiles(root: string = ROOT): FileSize[] {
  const out: FileSize[] = []
  for (const path of listFiles(root)) {
    if (!SOURCE_EXT.test(path) && !/\.md$/.test(path)) continue
    out.push({ path, lines: countLines(readFileSync(join(root, path), 'utf8')), group: groupOf(path) })
  }
  return out
}

export interface FnSize {
  /** `path::name`, with `Class.method` for a method and `outer>inner` for a function nested in another named one. */
  id: string
  path: string
  lines: number
}

/**
 * Name for a module-level function that has none of its own: the variable or `export default` it is the value of, looking
 * through parentheses, `as` / `satisfies` and the call that wraps it (`memo(...)`, `forwardRef(...)`). With `viaCalls` false
 * only the parentheses and casts are looked through, so a callback inside a named function is never given a name.
 */
function wrappedName(node: ts.Node, viaCalls: boolean): string | undefined {
  let child: ts.Node = node
  for (let p: ts.Node | undefined = node.parent; p; child = p, p = p.parent) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p)
    )
      continue
    if (viaCalls && ts.isCallExpression(p) && p.arguments.some((a) => a === child)) continue
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isExportAssignment(p)) return 'default'
    return undefined
  }
  return undefined
}

function nameOf(node: ts.Node, moduleLevel: boolean): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.getText()
  }
  if (ts.isFunctionDeclaration(node)) return 'default' // `export default function () {}`
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (ts.isGetAccessorDeclaration(node)) return `get ${node.name.getText()}`
  if (ts.isSetAccessorDeclaration(node)) return `set ${node.name.getText()}`
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText()
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left.getText()
    return wrappedName(node, moduleLevel)
  }
  return undefined
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** Sizes of the named functions in one TypeScript source text. Two functions with one id get `#2`, `#3`, ... */
export function measureFunctions(path: string, text: string): FnSize[] {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: FnSize[] = []
  const seen = new Map<string, number>()
  const visit = (node: ts.Node, scope: string[], depth: number): void => {
    let next = scope
    if (isFunctionLike(node)) {
      const own = nameOf(node, depth === 0)
      if (own !== undefined) {
        const owner = ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : ''
        const name = `${scope.length ? `${scope.join('>')}>` : ''}${owner}${own}`
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line
        const n = (seen.get(name) ?? 0) + 1
        seen.set(name, n)
        found.push({ id: `${path}::${name}${n > 1 ? `#${n}` : ''}`, path, lines: end - start + 1 })
        next = [...scope, own]
      }
    }
    // depth counts every function around a node, named or not: only a function with none around it is module level.
    ts.forEachChild(node, (c) => visit(c, next, isFunctionLike(node) ? depth + 1 : depth))
  }
  visit(sf, [], 0)
  return found
}

/** Function sizes for every production TypeScript file. Tests and the testkit's contract suites are not capped. */
export function measureAllFunctions(root: string = ROOT, files: FileSize[] = measureFiles(root)): FnSize[] {
  const out: FnSize[] = []
  for (const f of files) {
    if (f.group === 'tests' || f.group === 'testkit' || f.group === 'docs' || !TS_EXT.test(f.path)) continue
    out.push(...measureFunctions(f.path, readFileSync(join(root, f.path), 'utf8')))
  }
  return out
}

export interface Report {
  files: FileSize[]
  totals: Record<string, number>
  /** Production files by group, source code only (Markdown excluded). */
  fileCounts: Record<string, number>
  filesOver: (limit: number) => FileSize[]
  functions: FnSize[]
}

export function buildReport(root: string = ROOT): Report {
  const files = measureFiles(root)
  const totals: Record<string, number> = {}
  const fileCounts: Record<string, number> = {}
  for (const f of files) {
    totals[f.group] = (totals[f.group] ?? 0) + f.lines
    fileCounts[f.group] = (fileCounts[f.group] ?? 0) + 1
  }
  const functions = measureAllFunctions(root, files)
  return {
    files,
    totals,
    fileCounts,
    functions,
    filesOver: (limit) => files.filter((f) => f.group !== 'tests' && f.group !== 'docs' && f.lines > limit),
  }
}

const ORDER: Group[] = ['core', 'testkit', 'desktop', 'mobile', 'plugin', 'tooling', 'tests', 'docs', 'other']
const fmt = (n: number) => n.toLocaleString('en-US')

export function formatReport(r: Report): string {
  const lines: string[] = []
  const rows = ORDER.filter((g) => r.totals[g] !== undefined)
  const code = rows.filter((g) => g !== 'docs').reduce((s, g) => s + (r.totals[g] ?? 0), 0)
  lines.push('Talos size report. A line is a physical line of a tracked file (see scripts/size-report.ts).', '')
  lines.push('group     files      lines')
  for (const g of rows)
    lines.push(`${g.padEnd(9)} ${fmt(r.fileCounts[g] ?? 0).padStart(5)} ${fmt(r.totals[g] ?? 0).padStart(10)}`)
  lines.push(`${'code'.padEnd(9)} ${''.padStart(5)} ${fmt(code).padStart(10)}  (every group above except docs)`)
  lines.push('')
  const big = r.filesOver(1000).sort((a, b) => b.lines - a.lines)
  lines.push(`Production files over 1,000 lines: ${big.length}`)
  for (const f of big) lines.push(`  ${fmt(f.lines).padStart(6)}  ${f.path}`)
  const fns = r.functions.filter((f) => f.lines > 300).sort((a, b) => b.lines - a.lines)
  lines.push('', `Production TypeScript functions over 300 lines: ${fns.length}`)
  for (const f of fns) lines.push(`  ${fmt(f.lines).padStart(6)}  ${f.id}`)
  const over500 = r.filesOver(500).length
  const fnOver100 = r.functions.filter((f) => f.lines > 100).length
  lines.push('', `Report only: ${over500} production files over 500 lines, ${fnOver100} functions over 100 lines.`)
  return `${lines.join('\n')}\n`
}

export interface Budget {
  fileLines: number
  functionLines: number
  agentsChars: number
  /** Production files that were already over `fileLines` when the budget was set, with their size then. A closed list. */
  filesOverLimit: Record<string, number>
  /** Functions that were already over `functionLines`, by id, with their size then. A closed list. */
  functionsOverLimit: Record<string, number>
  /** How many entries each list holds and what they add up to. Adding an entry or raising a value means editing these too. */
  filesListedCount: number
  filesListedLines: number
  functionsListedCount: number
  functionsListedLines: number
}

export interface BudgetResult {
  /** Only AGENTS.md past its limit, or missing. Any entry fails the test. */
  failures: string[]
  /** A new file or function over its limit, or a list that no longer matches its recorded totals. Printed, never failing. */
  warnings: string[]
  /** Growth in a file or function that is already on the list. Printed, never failing. */
  growth: string[]
  /** List entries that are gone or back under the limit. Printed with the refresh command, never failing. */
  stale: string[]
}

export const REFRESH_COMMAND = 'node scripts/size-report.ts --refresh-budget'

const sum = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0)

/** Reads and checks scripts/size-budget.json. A missing or malformed file is an error, never an empty budget. */
export function loadBudget(root: string = ROOT): Budget {
  const file = join(root, 'scripts', 'size-budget.json')
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const bad = (why: string): never => {
    throw new Error(`scripts/size-budget.json: ${why}`)
  }
  if (typeof raw !== 'object' || raw === null) return bad('not an object')
  const o = raw as Record<string, unknown>
  for (const k of ['fileLines', 'functionLines', 'agentsChars']) {
    if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || (o[k] as number) <= 0)
      bad(`${k} must be a positive integer`)
  }
  for (const k of ['filesListedCount', 'filesListedLines', 'functionsListedCount', 'functionsListedLines']) {
    if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || (o[k] as number) < 0)
      bad(`${k} must be a whole number, 0 or more`)
  }
  for (const k of ['filesOverLimit', 'functionsOverLimit']) {
    const m = o[k]
    if (typeof m !== 'object' || m === null || Array.isArray(m)) bad(`${k} must be an object of name to line count`)
    for (const [name, n] of Object.entries(m as object)) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) bad(`${k}["${name}"] must be a positive integer`)
    }
  }
  return o as unknown as Budget
}

/** Number of characters (code points), the unit AGENTS.md is limited in. */
export function countChars(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/**
 * Compares the tree to the closed list and says what changed, without judging it. `newOver` are the paths and ids over the
 * limit that are not on the list; `growth` are listed ones now bigger than recorded; `stale` are listed ones that are gone or
 * back under the limit.
 */
export function compareToList(report: Report, budget: Budget) {
  const newOver: string[] = []
  const growth: string[] = []
  const stale: string[] = []

  const fileNow = new Map(report.filesOver(0).map((f) => [f.path, f.lines]))
  for (const [path, lines] of fileNow) {
    const was = budget.filesOverLimit[path]
    if (lines <= budget.fileLines) continue
    if (was === undefined) {
      newOver.push(
        `${path} has ${lines} lines; new production files stay at ${budget.fileLines} or fewer. Split it, or put new code in a new file.`,
      )
    } else if (lines > was) growth.push(`${path} grew from ${was} to ${lines} lines`)
  }
  for (const [path, was] of Object.entries(budget.filesOverLimit)) {
    const now = fileNow.get(path)
    if (now === undefined) stale.push(`${path} is on the big-file list (${was} lines) but is gone or no longer counted`)
    else if (now <= budget.fileLines) stale.push(`${path} is down to ${now} lines, under the ${budget.fileLines} limit`)
  }

  const fnNow = new Map(report.functions.map((f) => [f.id, f.lines]))
  for (const [id, lines] of fnNow) {
    const was = budget.functionsOverLimit[id]
    if (lines <= budget.functionLines) continue
    if (was === undefined) {
      newOver.push(
        `${id} has ${lines} lines; new functions stay at ${budget.functionLines} or fewer. Split it. (If you only renamed a listed function, rename its entry in scripts/size-budget.json.)`,
      )
    } else if (lines > was) growth.push(`${id} grew from ${was} to ${lines} lines`)
  }
  for (const [id, was] of Object.entries(budget.functionsOverLimit)) {
    const now = fnNow.get(id)
    if (now === undefined)
      stale.push(`${id} is on the big-function list (${was} lines) but no longer exists under that name`)
    else if (now <= budget.functionLines)
      stale.push(`${id} is down to ${now} lines, under the ${budget.functionLines} limit`)
  }
  return { newOver, growth, stale }
}

/**
 * The size rules. Only AGENTS.md past its limit fails. A production file or function over its limit that is not on the list, or
 * a list that no longer matches its recorded count and total (an entry added or a value raised), is a warning.
 * Warnings, growth and stale entries are returned for printing.
 */
export function checkBudget(report: Report, budget: Budget, agentsText: string | undefined): BudgetResult {
  const failures: string[] = []
  const warnings: string[] = []

  if (agentsText === undefined) failures.push('AGENTS.md is missing from the repo root')
  else {
    const n = countChars(agentsText)
    if (n > budget.agentsChars) failures.push(`AGENTS.md is ${n} characters; the limit is ${budget.agentsChars}`)
  }

  const { newOver, growth, stale } = compareToList(report, budget)
  warnings.push(...newOver)

  const lists: [string, Record<string, number>, number, number][] = [
    ['filesOverLimit', budget.filesOverLimit, budget.filesListedCount, budget.filesListedLines],
    ['functionsOverLimit', budget.functionsOverLimit, budget.functionsListedCount, budget.functionsListedLines],
  ]
  for (const [name, m, count, lines] of lists) {
    const n = Object.keys(m).length
    const total = sum(m)
    if (n !== count || total !== lines)
      warnings.push(
        `${name} holds ${n} entries adding up to ${total} lines, but scripts/size-budget.json records ${count} and ${lines}. The list is closed: do not add an entry or raise a number. If you only removed or lowered entries, run \`${REFRESH_COMMAND}\`.`,
      )
  }
  return { failures, warnings, growth, stale }
}

/**
 * The list after a refresh: gone entries and entries now at or under their limit dropped, shrunk entries that are still over
 * lowered (never raised, never added), totals recomputed.
 */
export function refreshBudget(report: Report, budget: Budget): Budget {
  const fileNow = new Map(report.filesOver(0).map((f) => [f.path, f.lines]))
  const fnNow = new Map(report.functions.map((f) => [f.id, f.lines]))
  const lower = (m: Record<string, number>, now: Map<string, number>, limit: number) => {
    const out: Record<string, number> = {}
    for (const [k, was] of Object.entries(m)) {
      const n = now.get(k)
      if (n !== undefined && n > limit) out[k] = Math.min(was, n)
    }
    return out
  }
  const filesOverLimit = lower(budget.filesOverLimit, fileNow, budget.fileLines)
  const functionsOverLimit = lower(budget.functionsOverLimit, fnNow, budget.functionLines)
  return {
    ...budget,
    filesOverLimit,
    functionsOverLimit,
    filesListedCount: Object.keys(filesOverLimit).length,
    filesListedLines: sum(filesOverLimit),
    functionsListedCount: Object.keys(functionsOverLimit).length,
    functionsListedLines: sum(functionsOverLimit),
  }
}

/** The report's sections about the closed list: what grew, what is stale, what is new and over. Empty when all is quiet. */
export function formatListStatus(r: Report, b: Budget): string {
  const { newOver, growth, stale } = compareToList(r, b)
  const out: string[] = []
  if (newOver.length)
    out.push('', 'New and over the limit (the size test warns on these):', ...newOver.map((x) => `  ${x}`))
  if (growth.length)
    out.push(
      '',
      'Listed giants that grew since the list was set (reported, not blocked):',
      ...growth.map((x) => `  ${x}`),
    )
  if (stale.length)
    out.push(
      '',
      `Stale list entries (never a failure; refresh with \`${REFRESH_COMMAND}\`):`,
      ...stale.map((x) => `  ${x}`),
    )
  return out.length ? `${out.join('\n')}\n` : ''
}

// realpath: run through a symlinked folder (macOS /tmp, /var), argv[1] and import.meta.url differ and the report would print nothing.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = buildReport()
  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ totals: r.totals, fileCounts: r.fileCounts, filesOver1000: r.filesOver(1000), functionsOver300: r.functions.filter((f) => f.lines > 300) }, null, 2)}\n`,
    )
  } else if (process.argv.includes('--refresh-budget')) {
    const next = refreshBudget(r, loadBudget())
    writeFileSync(join(ROOT, 'scripts', 'size-budget.json'), `${JSON.stringify(next, null, 2)}\n`)
    process.stdout.write(
      'scripts/size-budget.json refreshed: gone and under-limit entries dropped, shrunk entries lowered.\n',
    )
  } else {
    process.stdout.write(formatReport(r))
    try {
      process.stdout.write(formatListStatus(r, loadBudget()))
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`)
      process.exitCode = 1
    }
  }
}
