// The timing lint: a test that waits a fixed number of milliseconds, or whose waits add up to more than its own timeout, fails on a
// loaded machine. The same fix landed 13 times in 7 days (ace76cd5: peer/link.test.ts). Rules:
//   (a) unscaled      a literal timeout or wait that does not scale with TALOS_TEST_TIME_FACTOR: bun's test(name, fn, n) and
//                     setDefaultTimeout(n); vi.setConfig({ testTimeout, hookTimeout }), it(name, fn, n) and { timeout: n };
//                     waitFor(fn, n) / eventually(fn, n); sleeps (new Promise(r => setTimeout(r, n)), sleep(n)); Playwright's
//                     { timeout: n }, waitForTimeout(n), test.setTimeout(n), expect.poll. Scaled: t(n), scaled(n), n * F,
//                     timeFactor(), a named constant defined from one of those. 50 ms or less (a yield) passes.
//   (a) speed         a fixed limit on a measured time (expect(elapsed).toBeLessThan(150), python's `assert dt < 1`): scale it,
//                     unless it is a ratio of two times measured on the same machine (packages/testkit/src/time-factor.ts).
//   (a) empty-reason  `// timing-ok:` with no reason.
//   (b) exceeds       the waits inside one test add up to more than its effective timeout (the test's own third argument or
//                     test.setTimeout, else the file's setDefaultTimeout / setConfig, else the runner's: bun 5 s, vitest 30 s,
//                     Playwright 30 s (web) or 90 s (e2e), all at factor 1). Static and best effort: waits in a loop, a branch,
//                     a callback or Promise.all are not summed; --strict reports "cannot-prove" for a test they might push over.
//   (c) long-advance  (a warning) a fake-clock advance of more than an hour replays every timer in between: clock.jump() or
//                     clock.set() (7d1846cf).
//   (d) unreasoned-skip  a skipped test that does not say why: it.skip / test.skip / describe.skip / .skipIf( / xit( in vitest, bun and
//                     Playwright, and Swift Testing's .disabled(. The reason is a `// skip: <why>` (or `// quarantine: <why>`) comment on the
//                     line or the line before; Playwright's test.skip(cond, "why") and Swift's .disabled("why") carry it in the call.
// `// timing-ok: <reason>` on the line, or the line before, allows one. --changed <base> reports only added or changed lines.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Rule =
  | 'unscaled'
  | 'speed'
  | 'empty-reason'
  | 'exceeds'
  | 'cannot-prove'
  | 'long-advance'
  | 'unreasoned-skip'
export type Hit = {
  file: string
  line: number
  rule: Rule
  text: string
  hint: string
  /** a warning: printed, never fails */
  warn?: boolean
  /** (b): the lines of the test, so --changed can tell whether its body changed */
  span?: [number, number]
  /** lines away from the hit whose change changes it: a constant's definition, the timeout setter the test runs under */
  touch?: number[]
}
export type Opts = { strict?: boolean }

const YIELD_MS = 50
const HOUR = 3_600_000
const BUILTIN: Record<string, number> = {
  SECOND: 1000,
  SEC: 1000,
  MINUTE: 60_000,
  MIN: 60_000,
  HOUR,
  DAY: 86_400_000,
  WEEK: 604_800_000, // biome-ignore format: a table
}

// ---- reading source ------------------------------------------------------------------------------------------------------
/** The text with comments and the inside of strings blanked (same length, newlines kept), and each comment by its line. */
function mask(text: string): { masked: string; comments: Map<number, string> } {
  const out = text.split('')
  const comments = new Map<number, string>()
  let line = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    const n = text[i + 1]
    if (c === '\n') line++
    else if (c === '/' && n === '/') {
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      comments.set(line, text.slice(i, j))
      for (let k = i; k < j; k++) out[k] = ' '
      i = j - 1
    } else if (c === '/' && n === '*') {
      let j = text.indexOf('*/', i + 2)
      j = j < 0 ? text.length : j + 2
      const startLine = line
      for (let k = i; k < j; k++) {
        if (text[k] === '\n') line++
        else out[k] = ' '
      }
      comments.set(startLine, text.slice(i, Math.min(j, text.indexOf('\n', i) < 0 ? j : text.indexOf('\n', i))))
      i = j - 1
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) {
        if (text[j] === '\\') j++
        if (text[j] === '\n') line++
        j++
      }
      for (let k = i + 1; k < j; k++) if (text[k] !== '\n') out[k] = ' '
      i = j
    }
  }
  return { masked: out.join(''), comments }
}

type Arg = { s: number; e: number }
type Call = { at: number; open: number; close: number; args: Arg[] }

/** Each call whose callee `re` (global, ending at the open paren) matches, with its top-level arguments. */
function calls(masked: string, re: RegExp): Call[] {
  const out: Call[] = []
  for (const m of masked.matchAll(re)) {
    const open = m.index + m[0].length - 1
    const args: Arg[] = []
    let depth = 0
    let s = open + 1
    let close = -1
    for (let i = open + 1; i < masked.length; i++) {
      const c = masked[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) {
          close = i
          break
        }
        depth--
      } else if (c === ',' && depth === 0) {
        args.push({ s, e: i })
        s = i + 1
      }
    }
    if (close < 0) continue
    args.push({ s, e: close })
    out.push({ at: m.index, open, close, args: args.filter((a) => masked.slice(a.s, a.e).trim() !== '') })
  }
  return out
}

// ---- a millisecond expression --------------------------------------------------------------------------------------------
type Val = { ms: number; scaled: boolean; refs: string[] }

/** `expr` as milliseconds, and whether it scales with the time factor; undefined when it is not plain arithmetic. */
function evalMs(expr: string, consts: Map<string, string>, scalers: Set<string>, depth = 0): Val | undefined {
  const toks = expr.match(/\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$.]*|\*\*|[()*+\-/]|\S/g) ?? []
  let p = 0
  const fail = (): never => {
    throw new Error('no')
  }
  const atom = (): Val => {
    const tk = toks[p++]
    if (tk === undefined) return fail()
    if (/^\d/.test(tk)) return { ms: Number(tk.replace(/_/g, '')), scaled: false, refs: [] }
    if (tk === '(') {
      const v = sum()
      if (toks[p++] !== ')') fail()
      return v
    }
    if (/^[A-Za-z_$]/.test(tk)) {
      if (toks[p] === '(') {
        p++
        if (tk === 'timeFactor') {
          if (toks[p++] !== ')') fail()
          return { ms: 1, scaled: true, refs: [] }
        }
        const v = sum()
        if (toks[p++] !== ')') fail()
        if (scalers.has(tk)) return { ms: v.ms, scaled: true, refs: v.refs }
        if (/^Math\.(round|ceil|floor|abs)$/.test(tk)) return v
        return fail()
      }
      if (tk === 'F') return { ms: 1, scaled: true, refs: [] }
      const def = consts.get(tk)
      if (def !== undefined && depth < 6) {
        const v = evalMs(def, consts, scalers, depth + 1)
        if (v) return { ...v, refs: [tk, ...v.refs] }
      }
      const b = BUILTIN[tk]
      if (b !== undefined) return { ms: b, scaled: false, refs: [] }
    }
    return fail()
  }
  const unary = (): Val => {
    if (toks[p] === '-') {
      p++
      const v = atom()
      return { ms: -v.ms, scaled: v.scaled, refs: v.refs }
    }
    return atom()
  }
  const term = (): Val => {
    let v = unary()
    while (toks[p] === '*' || toks[p] === '/') {
      const op = toks[p++]
      const r = unary()
      v = { ms: op === '*' ? v.ms * r.ms : v.ms / r.ms, scaled: v.scaled || r.scaled, refs: [...v.refs, ...r.refs] }
    }
    return v
  }
  const sum = (): Val => {
    let v = term()
    while (toks[p] === '+' || toks[p] === '-') {
      const op = toks[p++]
      const r = term()
      v = { ms: op === '+' ? v.ms + r.ms : v.ms - r.ms, scaled: v.scaled && r.scaled, refs: [...v.refs, ...r.refs] }
    }
    return v
  }
  try {
    const v = sum()
    return p === toks.length ? v : undefined
  } catch {
    return undefined
  }
}

// ---- which runner a file belongs to ---------------------------------------------------------------------------------------
type Runner = 'bun' | 'vitest' | 'playwright'
function runnerOf(file: string, text: string): Runner {
  if (/from ['"]bun:test['"]/.test(text)) return 'bun'
  if (/\.spec\.tsx?$/.test(file) || /from ['"]@playwright\/test['"]/.test(text)) return 'playwright'
  return 'vitest'
}
const defaultTimeout = (r: Runner, file: string) =>
  r === 'bun' ? 5000 : r === 'vitest' ? 30_000 : file.startsWith('e2e/') ? 90_000 : 30_000

// ---- files ---------------------------------------------------------------------------------------------------------------
export function isTestFile(file: string): boolean {
  if (/(^|\/)(node_modules|fixtures)\//.test(file) || /\.d\.ts$/.test(file)) return false
  if (/^kit\/scripts\/test-[^/]+\.sh$/.test(file)) return true
  if (/(^|\/)[A-Za-z]*Tests?\/.*\.swift$/.test(file)) return true // the (d) skip rule only: lintSource sends Swift there
  if (!/\.(m?ts|tsx)$/.test(file)) return false
  return (
    /^(apps|packages)\/[^/]+\/test(-browser)?\//.test(file) ||
    /^plugins\/[^/]+\/tests?\//.test(file) ||
    /^e2e\/(tests|harness)\//.test(file) ||
    /^scripts\/(.*\/)?[^/]+\.test\.ts$/.test(file) ||
    /\.spec\.tsx?$/.test(file)
  )
}

// ---- the lint ------------------------------------------------------------------------------------------------------------
const WHY_HINT =
  'wrap in t() from @talos-app/testkit (scripts/: scaled() from packages/testkit/src/time-factor.ts), or // timing-ok: <reason>'
const SPEED_HINT =
  'a budget on a measured time scales too: t(n) from @talos-app/testkit (a ratio of two times measured on this machine needs none), or // timing-ok: <reason>'
const ADVANCE_HINT =
  'a fake clock replays every timer in the advance: clock.jump(ms) when each due timer fires once, clock.set(ms) when none must run (7d1846cf), or advance(ms, { replay: true })'
const SPEED_SUBJECT =
  /elapsed|duration|took|\bdt\b|\bms\b|Ms\b|Date\.now|performance\.now|latency|spent|\btime\b|Time\b/
const SCALED_LINE = /TIME_FACTOR|\*\s*(F|tf)\b|\b(F|tf)\s*\*/
/** The testkit's waitFor multiplies its timeout by waitScale() (frame-utils.ts, TALOS_TEST_WAIT_SCALE, default 3) and has a 3 s
 * default; the bridge helpers' eventually has a 10 s default and no multiplier. */
const WAIT_SCALE = 3
const WAITFOR_DEFAULT_MS = 3000
const EVENTUALLY_DEFAULT_MS = 10_000
const DEADLINE = /\b(?:const|let)\s+(?:end|deadline|until|stopAt|giveUp|limit)\w*\s*=\s*Date\.now\(\)\s*\+\s*([^;\n]+)/g
/** A sleep: a bare sleep(n), wait(n) or delay(n) helper (a method on an object, fake.sleep(), is not one), or Bun.sleep(n). */
const SLEEP = /(?:(?<![\w$.])(?:sleep|sleepSync|delay|wait)|\bBun\.(?:sleep|sleepSync))\s*\(/g
/** The calls whose object argument may hold a timeout: waits, assertions, actions, and the test's own limit. */
const TIMEOUT_CALLEE =
  /^(?:expect|poll|toPass|to[A-Z]\w*|waitFor\w*|waitUntil|test|it|describe|configure|setConfig|setTimeout|goto|click|dblclick|fill|press|type|check|uncheck|hover|tap|selectOption|setInputFiles|reload|goBack|goForward|isVisible|isHidden|isEnabled|isDisabled|isChecked|textContent|innerText|inputValue|focus|blur|dragTo)$/
const LIMIT_CALLEE = /^(?:test|it|describe|configure|setConfig|setTimeout|waitFor|waitUntil)$/

type Wait = { at: number; ms: number; what: string; refs: string[] }
type TestCall = Call & { bodyFrom: number; bodyTo: number; line: number }
type Ctx = {
  file: string
  masked: string
  runner: Runner
  opts: Opts
  /** the testing-library waitFor is imported (an unscaled wait, unlike the testkit's) */
  rtl: boolean
  nodeTimers: boolean
  promiseSpans: Call[]
  constLine: Map<string, number>
  lineOf: (pos: number) => number
  argLine: (a: Arg) => number
  shown: (n: number) => string
  raw: (a: Arg) => string
  ev: (a: Arg) => Val | undefined
  objKey: (a: Arg | undefined, key: RegExp) => Arg | undefined
  add: (h: Hit, allow?: number[]) => void
  /** the lines of the constants a value came from: a change there changes the hit */
  touch: (refs: string[]) => number[]
}

/** The callee of the call whose argument list holds the object `pos` is in, and where its `(` is. */
function enclosingCall(masked: string, pos: number): { name: string; open: number } | undefined {
  let depth = 0
  let braced = false
  for (let i = pos - 1; i >= 0 && pos - i < 3000; i--) {
    const ch = masked[i]
    if (ch === ')' || ch === ']' || ch === '}') depth++
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      if (!braced) {
        if (ch !== '{') return undefined
        braced = true
        continue
      }
      if (ch !== '(') return undefined
      const name = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, i - 60), i))?.[1]
      return name ? { name, open: i } : undefined
    }
  }
  return undefined
}

/** The callee of every call `pos` is inside, innermost first. */
function enclosingCalls(masked: string, pos: number): string[] {
  const names: string[] = []
  let depth = 0
  for (let i = pos - 1; i >= 0 && pos - i < 3000; i--) {
    const ch = masked[i]
    if (ch === ')' || ch === ']' || ch === '}') depth++
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) depth--
      else if (ch === '(') {
        const name = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, i - 60), i))?.[1]
        if (name) names.push(name)
      }
    }
  }
  return names
}

/** The end of the value that starts at `s`: the next top-level comma, newline, semicolon or closing bracket. */
function valueEnd(masked: string, s: number, stopAtNewline: boolean): number {
  let depth = 0
  let e = s
  for (; e < masked.length; e++) {
    const c = masked[e]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && (c === ',' || (stopAtNewline && (c === '\n' || c === ';')))) break
  }
  return e
}

function makeCtx(file: string, text: string, opts: Opts, out: Hit[]): Ctx {
  const lines = text.split('\n')
  const { masked, comments } = mask(text)
  const seen = new Set<string>()
  /** The reason of a `timing-ok:` comment on that line: undefined when there is none, '' when it is empty. */
  const allowReason = (n: number): string | undefined => {
    const c = comments.get(n)
    const m = c === undefined ? null : /(?:\/\/|\/\*)\s*timing-ok:(.*)$/.exec(c)
    return m ? (m[1] ?? '').replace(/\*\/\s*$/, '').trim() : undefined
  }
  const add = (h: Hit, allow: number[] = [h.line]) => {
    const key = `${h.line}:${h.rule}`
    if (seen.has(key)) return
    if (h.rule !== 'empty-reason' && allow.some((n) => [n, n - 1].some((l) => (allowReason(l) ?? '') !== ''))) return
    seen.add(key)
    out.push(h)
  }
  const shown = (n: number) => (lines[n - 1] ?? '').trim().slice(0, 140)
  for (let n = 1; n <= lines.length; n++)
    if (allowReason(n) === '')
      add({
        file,
        line: n,
        rule: 'empty-reason',
        text: shown(n),
        hint: 'give the reason after timing-ok: (why this wait is not scaled), or scale the wait',
      })
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (pos: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] as number) <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  // named constants (one line each), and the names that scale: t, scaled, and what the file imports t as
  const consts = new Map<string, string>()
  const constLine = new Map<string, number>()
  masked.split('\n').forEach((l, i) => {
    const m = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=(.*)$/.exec(l)
    if (!m) return
    consts.set(m[1] as string, (m[2] as string).trim().replace(/;$/, ''))
    constLine.set(m[1] as string, i + 1)
  })
  const scalers = new Set(['t', 'scaled'])
  for (const m of text.matchAll(/\bt\s+as\s+([A-Za-z_$][\w$]*)/g)) scalers.add(m[1] as string)
  const ev = (a: Arg) => evalMs(masked.slice(a.s, a.e).trim(), consts, scalers)
  const objKey = (a: Arg | undefined, key: RegExp): Arg | undefined => {
    if (!a || !masked.slice(a.s, a.e).trim().startsWith('{')) return undefined
    const m = key.exec(masked.slice(a.s, a.e))
    if (!m) return undefined
    const s = a.s + m.index + m[0].length
    return { s, e: Math.min(valueEnd(masked, s, false), a.e) }
  }
  return {
    file,
    masked,
    runner: runnerOf(file, text),
    opts,
    rtl: /import\s*\{[^}]*\bwaitFor\b[^}]*\}\s*from\s*['"]@testing-library\//.test(text),
    nodeTimers: /import\s*\{[^}]*\bsetTimeout\b[^}]*\}\s*from\s*['"](?:node:)?timers\/promises['"]/.test(text),
    promiseSpans: calls(masked, /\bnew\s+Promise\s*\(/g),
    constLine,
    lineOf,
    argLine: (a) => lineOf(a.s + (masked.slice(a.s, a.e).length - masked.slice(a.s, a.e).trimStart().length)),
    shown,
    raw: (a) => text.slice(a.s, a.e).trim(),
    ev,
    objKey,
    add,
    touch: (refs) => refs.map((r) => constLine.get(r)).filter((n): n is number => n !== undefined),
  }
}

/** (a): a literal wait. Returns what the argument evaluates to. */
function literal(c: Ctx, a: Arg | undefined, extra: number[] = []): Val | undefined {
  if (!a) return undefined
  const v = c.ev(a)
  if (!v) return undefined
  if (!v.scaled && v.ms > YIELD_MS) {
    const line = c.argLine(a)
    c.add({ file: c.file, line, rule: 'unscaled', text: c.shown(line), hint: WHY_HINT, touch: c.touch(v.refs) }, [
      line,
      ...extra,
    ])
  }
  return v
}

const isObject = (c: Ctx, a: Arg) => c.masked.slice(a.s, a.e).trim().startsWith('{')

/** The tests of the file: test(name, fn[, timeout]) and it(...), with the span of each body. */
function findTests(c: Ctx): TestCall[] {
  const tests: TestCall[] = []
  const re = /(?<![\w$.])(?:test|it)(?:\.(?:only|skip|todo|concurrent|serial|fails|failing|fixme))?\s*\(/g
  for (const k of calls(c.masked, re)) {
    const [name, fn] = k.args
    if (!name || !fn || !/^['"`]/.test(c.raw(name))) continue
    const f = c.masked.slice(fn.s, fn.e)
    if (!/=>|\bfunction\b/.test(f)) continue
    // the body's brace: the first one after the arrow (or the parameter list), not a destructured parameter's
    const arrow = f.indexOf('=>')
    const rest = f.slice(arrow >= 0 ? arrow + 2 : Math.max(0, f.indexOf(')')) + 1)
    const b = rest.trimStart().startsWith('{')
      ? fn.s + f.length - rest.length + (rest.length - rest.trimStart().length)
      : -1
    tests.push({ ...k, bodyFrom: b < 0 ? fn.s : b + 1, bodyTo: fn.e, line: c.lineOf(k.at) })
  }
  return tests
}

/** (a) on every timeout and wait the file writes with a literal. */
function scanLiterals(c: Ctx, tests: TestCall[]): void {
  const { masked } = c
  for (const m of masked.matchAll(/\b(timeout|testTimeout|hookTimeout)\s*:\s*/g)) {
    const name = enclosingCall(masked, m.index)?.name
    if (!name || !TIMEOUT_CALLEE.test(name)) continue
    const s = m.index + m[0].length
    literal(c, { s, e: valueEnd(masked, s, true) })
  }
  for (const t of tests) {
    const third = t.args[2]
    if (third && !isObject(c, third)) literal(c, third, [t.line])
  }
  for (const re of [/(?<![\w$])setDefaultTimeout\s*\(/g, /(?<![\w$])(?:test|jest)\.setTimeout\s*\(/g])
    for (const k of calls(masked, re)) literal(c, k.args[0])
  for (const k of calls(masked, /\b(vi\.)?waitFor\s*\(|\bvi\.waitUntil\s*\(/g)) {
    const vi = masked.slice(k.at, k.open).startsWith('vi.')
    const plain = masked[k.at - 1] !== '.'
    const a = k.args[1]
    if (a && !isObject(c, a) && (vi || (c.rtl && plain))) literal(c, a, [c.lineOf(k.at)])
  }
  for (const k of calls(masked, /\beventually\s*\(/g)) {
    const a = k.args[1]
    if (a && !isObject(c, a)) literal(c, a, [c.lineOf(k.at)])
  }
  for (const k of calls(masked, /\bwaitForTimeout\s*\(/g)) literal(c, k.args[0], [c.lineOf(k.at)])
  if (!/useFakeTimers/.test(masked)) {
    for (const k of calls(masked, SLEEP)) literal(c, k.args[0], [c.lineOf(k.at)])
    for (const k of calls(masked, /(?<![\w$.])setTimeout\s*\(/g)) {
      const [first, ms] = k.args
      if (!first) continue
      if (c.nodeTimers) {
        literal(c, first, [c.lineOf(k.at)])
        continue
      }
      const bare = /^[A-Za-z_$][\w$]*$/.test(masked.slice(first.s, first.e).trim())
      if (ms && (bare || c.promiseSpans.some((p) => p.open < k.at && k.at < p.close))) literal(c, ms, [c.lineOf(k.at)])
    }
  }
  for (const m of masked.matchAll(DEADLINE)) {
    const s = m.index + m[0].length - (m[1] as string).length
    literal(c, { s, e: s + (m[1] as string).length })
  }
}

/** (a) speed budgets, and (c) a long fake-clock advance. */
function scanSpeedAndAdvance(c: Ctx): void {
  const { masked, file } = c
  for (const k of calls(masked, /\.toBeLessThan(?:OrEqual)?\s*\(/g)) {
    const before = masked.slice(Math.max(0, k.at - 400), k.at)
    const ex = before.lastIndexOf('expect(')
    if (ex < 0 || !SPEED_SUBJECT.test(before.slice(ex))) continue
    const a = k.args[0]
    const v = a && c.ev(a)
    if (a && v && !v.scaled && v.ms > YIELD_MS && v.ms <= 60_000 && !/Math\.abs/.test(before.slice(ex))) {
      const line = c.argLine(a)
      c.add({ file, line, rule: 'speed', text: c.shown(line), hint: SPEED_HINT, touch: c.touch(v.refs) })
    }
  }
  // a time compared inside an assertion (not in `if (Date.now() - t < 500)` logic)
  for (const m of masked.matchAll(/(?:Date|performance)\.now\(\)\s*-\s*[\w.$]+\s*<=?\s*(\d[\d_]*)(?!\s*[*+\-/\w])/g)) {
    if (Number((m[1] as string).replace(/_/g, '')) <= YIELD_MS) continue
    if (!enclosingCalls(masked, m.index).some((n) => /^(?:expect|assert|ok)$/.test(n))) continue
    const line = c.lineOf(m.index)
    c.add({ file, line, rule: 'speed', text: c.shown(line), hint: SPEED_HINT })
  }
  for (const k of calls(masked, /\.(?:advance|advanceTimersByTime|advanceTimersByTimeAsync|tickAsync|tick)\s*\(/g)) {
    const a = k.args[0]
    if (!a || (k.args[1] && /replay/.test(masked.slice(k.args[1].s, k.args[1].e)))) continue
    const v = c.ev(a)
    if (v && v.ms > HOUR) {
      const line = c.lineOf(k.at)
      c.add({ file, line, rule: 'long-advance', text: c.shown(line), hint: ADVANCE_HINT, warn: true })
    }
  }
}

/** Every wait the file makes, by where it starts, with what the test really waits (waitFor at waitScale x its timeout). */
function collectWaits(c: Ctx): Wait[] {
  const { masked } = c
  const w: Wait[] = []
  const push = (at: number, ms: number | undefined, what: string, refs: string[] = []) => {
    if (ms !== undefined && ms > 0) w.push({ at, ms, what, refs })
  }
  const timeoutOf = (a: Arg | undefined) => {
    const key = a && c.objKey(a, /\btimeout\s*:\s*/)
    return key ? c.ev(key) : undefined
  }
  for (const k of calls(masked, /\b(vi\.)?waitFor\s*\(|\bvi\.waitUntil\s*\(/g)) {
    const vi = masked.slice(k.at, k.open).startsWith('vi.')
    const plain = masked[k.at - 1] !== '.'
    const [a0, a1] = k.args
    if (vi || c.rtl) {
      const v = a1 && (isObject(c, a1) ? timeoutOf(a1) : c.ev(a1))
      if (v) push(k.at, v.ms, 'waitFor', v.refs)
    } else if (!plain || c.runner === 'playwright') {
      const v = timeoutOf(a0) // locator.waitFor({ timeout })
      if (v) push(k.at, v.ms, 'waitFor', v.refs)
    } else {
      // the testkit's waitFor: its timeout (default 3 s) x waitScale
      const v = a1 ? c.ev(a1) : { ms: WAITFOR_DEFAULT_MS, scaled: false, refs: [] }
      if (v) push(k.at, v.ms * WAIT_SCALE, `waitFor ${v.ms} x${WAIT_SCALE}`, v.refs)
    }
  }
  for (const k of calls(masked, /\beventually\s*\(/g)) {
    const v = k.args[1] ? c.ev(k.args[1]) : { ms: EVENTUALLY_DEFAULT_MS, scaled: false, refs: [] }
    if (v) push(k.at, v.ms, 'eventually', v.refs)
  }
  const sleep = (k: Call, a: Arg | undefined) => {
    const v = a && c.ev(a)
    if (v) push(k.at, v.ms, 'sleep', v.refs)
  }
  for (const k of calls(masked, /\bwaitForTimeout\s*\(/g)) sleep(k, k.args[0])
  for (const k of calls(masked, SLEEP)) sleep(k, k.args[0])
  for (const k of calls(masked, /(?<![\w$.])setTimeout\s*\(/g)) {
    const [first, ms] = k.args
    if (!first) continue
    if (c.nodeTimers) sleep(k, first)
    else {
      const bare = /^[A-Za-z_$][\w$]*$/.test(masked.slice(first.s, first.e).trim())
      if (ms && (bare || c.promiseSpans.some((p) => p.open < k.at && k.at < p.close))) sleep(k, ms)
    }
  }
  for (const m of masked.matchAll(DEADLINE)) {
    const s = m.index + m[0].length - (m[1] as string).length
    const v = c.ev({ s, e: s + (m[1] as string).length })
    if (v) push(m.index, v.ms, 'poll deadline', v.refs)
  }
  // a timeout in an assertion, an action or expect.poll adds to the test's time
  for (const m of masked.matchAll(/\btimeout\s*:\s*/g)) {
    const call = enclosingCall(masked, m.index)
    if (!call || !TIMEOUT_CALLEE.test(call.name) || LIMIT_CALLEE.test(call.name)) continue
    const s = m.index + m[0].length
    const v = c.ev({ s, e: valueEnd(masked, s, true) })
    if (v) push(masked.lastIndexOf(call.name, call.open), v.ms, 'timeout', v.refs)
  }
  return w.sort((a, b) => a.at - b.at)
}

type Limit = { ms: number; touch: number[] }

/** The file's default timeout (a setter outside every test), with the lines a change to it comes from. */
function fileDefault(c: Ctx, tests: TestCall[]): Limit | undefined {
  const { masked } = c
  const outside = (k: Call) => !tests.some((t) => t.bodyFrom <= k.at && k.at < t.bodyTo)
  const from = (k: Call, a: Arg | undefined): Limit | undefined => {
    const v = a && c.ev(a)
    return v ? { ms: v.ms, touch: [c.lineOf(k.at), ...c.touch(v.refs)] } : undefined
  }
  for (const re of [/(?<![\w$])setDefaultTimeout\s*\(/g, /(?<![\w$])test\.setTimeout\s*\(/g])
    for (const k of calls(masked, re)) {
      const l = outside(k) ? from(k, k.args[0]) : undefined
      if (l) return l
    }
  for (const [re, key] of [
    [/\bdescribe\.configure\s*\(/g, /\btimeout\s*:\s*/],
    [/\bsetConfig\s*\(/g, /\btestTimeout\s*:\s*/],
  ] as const)
    for (const k of calls(masked, re)) {
      const l = outside(k) ? from(k, c.objKey(k.args[0], key)) : undefined
      if (l) return l
    }
  return undefined
}

/** A test's own timeout (its third argument, or a test.setTimeout inside it), else the file's, else the runner's. */
function limitOf(c: Ctx, t: TestCall, dflt: Limit | undefined): Limit | undefined {
  const third = t.args[2]
  if (third) {
    const a = isObject(c, third) ? c.objKey(third, /\btimeout\s*:\s*/) : third
    const v = a && c.ev(a)
    return v ? { ms: v.ms, touch: [t.line, ...c.touch(v.refs)] } : undefined
  }
  const body = c.masked.slice(t.bodyFrom, t.bodyTo)
  const own = /(?<![\w$])test\.setTimeout\s*\(/.exec(body)
  const k = own && calls(body.slice(own.index), /(?<![\w$])test\.setTimeout\s*\(/g)[0]
  const ov = k?.args[0] && c.ev({ s: t.bodyFrom + own.index + k.args[0].s, e: t.bodyFrom + own.index + k.args[0].e })
  let ms = ov ? ov.ms : (dflt?.ms ?? defaultTimeout(c.runner, c.file))
  if (/\btest\.slow\s*\(/.test(body)) ms *= 3
  return { ms, touch: ov ? [t.line] : (dflt?.touch ?? []) }
}

/** (b): the waits that must run one after another inside a test, against its timeout. */
function checkExceeds(c: Ctx, tests: TestCall[]): void {
  const { masked, file } = c
  const all = collectWaits(c)
  const dflt = fileDefault(c, tests)
  for (const t of tests) {
    const w = all.filter((x) => x.at >= t.bodyFrom && x.at < t.bodyTo)
    const limit = w.length ? limitOf(c, t, dflt) : undefined
    if (!limit) continue
    // certain: not in a loop, a branch, a callback or a Promise.all, and not in another wait's own arguments
    const certain: Wait[] = []
    const maybe: Wait[] = []
    const stack: string[] = []
    let wi = 0
    for (let i = t.bodyFrom; i < t.bodyTo && wi < w.length; i++) {
      while (wi < w.length && (w[wi] as Wait).at === i) {
        if (!stack.includes('wait')) (stack.some((k) => k !== 'plain') ? maybe : certain).push(w[wi] as Wait)
        wi++
      }
      const ch = masked[i]
      if (ch === '{' || ch === '(' || ch === '[')
        stack.push(ch === '(' ? parenKind(masked, i) : ch === '{' ? braceKind(masked, i) : 'plain')
      else if (ch === '}' || ch === ')' || ch === ']') stack.pop()
    }
    const sum = certain.reduce((n, x) => n + x.ms, 0)
    const most = sum + maybe.reduce((n, x) => n + x.ms, 0)
    const span: [number, number] = [t.line, c.lineOf(t.bodyTo)]
    const touch = [...limit.touch, ...c.touch(certain.flatMap((x) => x.refs))]
    const label = c.shown(t.line)
    if (sum > limit.ms) {
      const how = {
        bun: 'a third argument or setDefaultTimeout(t(N))',
        vitest: 'a third argument or vi.setConfig({ testTimeout: scaled(N) })',
        playwright: 'test.setTimeout(N)',
      }[c.runner]
      c.add(
        {
          file,
          line: t.line,
          rule: 'exceeds',
          span,
          touch,
          text: `${label}  [waits ${certain.map((x) => x.ms).join(' + ')} = ${sum} ms; timeout ${limit.ms} ms]`,
          hint: `raise the test's timeout above ${sum} ms (${how}), or shorten the waits`,
        },
        [t.line],
      )
    } else if (c.opts.strict && most > limit.ms)
      c.add(
        {
          file,
          line: t.line,
          rule: 'cannot-prove',
          span,
          touch,
          text: `${label}  [certain ${sum} ms, with loops and branches up to ${most} ms; timeout ${limit.ms} ms]`,
          hint: 'check the waits in loops, branches and callbacks against the timeout',
        },
        [t.line],
      )
  }
}

/** A kit test: python and shell, line by line. */
function lintShell(file: string, text: string, opts: Opts): Hit[] {
  const out: Hit[] = []
  const lines = text.split('\n')
  const reason = (n: number) => /#\s*timing-ok:(.*)$/.exec(lines[n - 1] ?? '')?.[1]?.trim()
  const add = (h: Hit) => {
    if ([h.line, h.line - 1].some((n) => (reason(n) ?? '') !== '') && h.rule !== 'empty-reason') return
    out.push(h)
  }
  void opts
  lines.forEach((l, i) => {
    const n = i + 1
    const text1 = l.trim().slice(0, 140)
    if (reason(n) === '')
      add({
        file,
        line: n,
        rule: 'empty-reason',
        text: text1,
        hint: 'give the reason after timing-ok:, or scale the wait',
      })
    if (/^\s*#/.test(l) || SCALED_LINE.test(l)) return
    const sp = /\b(dt|elapsed|took|delta|srt\[[^\]]*\]|time\.time\(\)\s*-\s*\w+)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)/.exec(
      l,
    )
    if (sp)
      add({
        file,
        line: n,
        rule: 'speed',
        text: text1,
        hint: 'scale the limit: x float(os.environ.get("TALOS_TEST_TIME_FACTOR") or 1), or # timing-ok: <reason>',
      })
    const sl = /^\s*sleep\s+(\d+(?:\.\d+)?)\b/.exec(l)
    if (sl && Number(sl[1]) * 1000 > YIELD_MS)
      add({
        file,
        line: n,
        rule: 'unscaled',
        text: text1,
        hint: 'poll for the condition, or scale: sleep "$(( N * TALOS_TEST_TIME_FACTOR ))", or # timing-ok: <reason>',
      })
  })
  return out.sort((a, b) => a.line - b.line)
}

// ---- (d) a skip says why ---------------------------------------------------------------------------------------------------
const SKIP_HINT =
  'say why on this line or the line before: `// skip: <why>` (Playwright: test.skip(cond, "why"); Swift: .disabled("why")), or delete the test'
const SKIP_SITE = /\b(?:(?:it|test|describe|suite)\.skip|xit|xtest|xdescribe)\b|\.skipIf\s*\(/g
const SKIP_COMMENT = /(?:\/\/|\/\*)\s*(?:skip|quarantine):\s*\S/

/** A string literal with something in it: the reason a call carries (the masked text blanks it, so this reads the original). */
const nonEmptyString = (text: string, a: Arg | undefined): boolean =>
  a !== undefined && /^(["'`])\s*\S[\s\S]*\1$/.test(text.slice(a.s, a.e).trim())

/** The text of a Swift call's parentheses, from the open paren (strings and a line comment's text do not count as parens). */
function swiftCallArgs(text: string, open: number): string {
  let depth = 0
  let inStr = false
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

function lintSwiftSkips(file: string, text: string): Hit[] {
  const lines = text.split('\n')
  const said = (n: number) => [n, n - 1].some((l) => SKIP_COMMENT.test(lines[l - 1] ?? ''))
  const out: Hit[] = []
  let at = 0
  lines.forEach((l, i) => {
    const n = i + 1
    const start = at
    at += l.length + 1
    if (/^\s*\/\//.test(l)) return
    // a test trait: on the @Test / @Suite line, or the line or two after it that carries the traits
    const open = (x: string) => (x.match(/\(/g)?.length ?? 0) > (x.match(/\)/g)?.length ?? 0)
    if (
      !lines
        .slice(Math.max(0, i - 2), i + 1)
        .some((x, k, a) => /@(?:Test|Suite)\b/.test(x) && (k === a.length - 1 || open(x)))
    )
      return
    for (const m of l.matchAll(/\.disabled\s*\(/g)) {
      if (/"\s*[^"\s][^"]*"/.test(swiftCallArgs(text, start + m.index + m[0].length - 1)) || said(n)) continue
      out.push({ file, line: n, rule: 'unreasoned-skip', text: l.trim().slice(0, 140), hint: SKIP_HINT })
    }
  })
  return out
}

/** The skipped tests of one file that do not say why. */
export function lintSkips(file: string, text: string): Hit[] {
  if (file.endsWith('.swift')) return lintSwiftSkips(file, text)
  if (file.endsWith('.sh')) return []
  const { masked, comments } = mask(text)
  const playwright = runnerOf(file, text) === 'playwright'
  const lineAt = (pos: number) => masked.slice(0, pos).split('\n').length
  const out: Hit[] = []
  const seen = new Set<number>()
  for (const m of masked.matchAll(SKIP_SITE)) {
    const line = lineAt(m.index)
    if (seen.has(line)) continue
    if ([line, line - 1].some((n) => SKIP_COMMENT.test(comments.get(n) ?? ''))) continue
    // Playwright's test.skip(condition, "why"): the description is the second argument
    const call =
      playwright && m[0] === 'test.skip' ? calls(masked, /\btest\.skip\s*\(/g).find((c) => c.at === m.index) : undefined
    if (call && call.args.length >= 2 && nonEmptyString(text, call.args[1]) && !nonEmptyString(text, call.args[0]))
      continue
    seen.add(line)
    out.push({
      file,
      line,
      rule: 'unreasoned-skip',
      text: (text.split('\n')[line - 1] ?? '').trim().slice(0, 140),
      hint: SKIP_HINT,
    })
  }
  return out
}

export function lintSource(file: string, text: string, opts: Opts = {}): Hit[] {
  if (file.endsWith('.sh')) return lintShell(file, text, opts)
  if (file.endsWith('.swift')) return lintSkips(file, text)
  const out: Hit[] = []
  const c = makeCtx(file, text, opts, out)
  const tests = findTests(c)
  scanLiterals(c, tests)
  scanSpeedAndAdvance(c)
  checkExceeds(c, tests)
  out.push(...lintSkips(file, text))
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/** What a `(` opens: a wait call (its arguments are no extra time), a Promise.all-like call, or plain. */
function parenKind(masked: string, i: number): string {
  const before = masked.slice(Math.max(0, i - 24), i).trimEnd()
  if (/Promise\.(all|allSettled|race|any)$/.test(before)) return 'parallel'
  if (/(?:waitFor|eventually|poll)$/.test(before)) return 'wait'
  return 'plain'
}
/** What a `{` opens: a loop, a branch or a callback (not certain to run once), or plain (an object, a bare block). */
function braceKind(masked: string, i: number): string {
  let j = i - 1
  while (j >= 0 && /\s/.test(masked[j] as string)) j--
  if (masked.slice(Math.max(0, j - 1), j + 1) === '=>') return 'callback'
  if (/(?:\belse|\btry|\bfinally|\bdo)$/.test(masked.slice(Math.max(0, j - 7), j + 1))) return 'branch'
  if (masked[j] === ')') {
    let d = 0
    let k = j
    for (; k >= 0; k--) {
      if (masked[k] === ')') d++
      else if (masked[k] === '(' && --d === 0) break
    }
    const w = /([\w$.]+)\s*$/.exec(masked.slice(Math.max(0, k - 24), k))?.[1] ?? ''
    if (/^(for|while|if|switch|catch)$/.test(w)) return 'branch'
    return 'callback'
  }
  return 'plain'
}

// ---- the files, and --changed ---------------------------------------------------------------------------------------------
const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })

export function lintFiles(root: string, files: string[], opts: Opts = {}): Hit[] {
  return files.filter(isTestFile).flatMap((f) => {
    try {
      return lintSource(f, readFileSync(join(root, f), 'utf8'), opts)
    } catch {
      return []
    }
  })
}

/** The added or changed line numbers of each file between `base` and HEAD (git diff -U0 base...HEAD). */
export function changedLines(root: string, base: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let file = ''
  for (const l of git(root, ['diff', '-U0', '-M', '--diff-filter=AMR', `${base}...HEAD`]).split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? '' : l.slice(6)
      if (file) out.set(file, new Set())
    } else if (file) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l)
      if (m) for (let i = 0; i < Number(m[2] ?? 1); i++) out.get(file)?.add(Number(m[1]) + i)
    }
  }
  return out
}

export function lintChanged(root: string, base: string, opts: Opts = {}): Hit[] {
  const out: Hit[] = []
  for (const [file, added] of changedLines(root, base)) {
    if (!isTestFile(file)) continue
    let text: string
    try {
      text = git(root, ['show', `HEAD:${file}`])
    } catch {
      continue
    }
    for (const h of lintSource(file, text, opts)) {
      const [from, to] = h.span ?? [h.line, h.line]
      const lines = [...Array.from({ length: to - from + 1 }, (_, i) => from + i), ...(h.touch ?? [])]
      if (lines.some((n) => added.has(n))) out.push(h)
    }
  }
  return out
}

export const format = (h: Hit) => `${h.file}:${h.line}: ${h.warn ? 'warn ' : ''}${h.rule}: ${h.text}\n    -> ${h.hint}`

const pkgOf = (f: string) =>
  /^(apps|packages|plugins)\//.test(f) ? f.split('/').slice(0, 2).join('/') : (f.split('/')[0] ?? f)

/** The baseline report: counts by package and by rule, and the files with the most hits. */
export function summary(hits: Hit[], top = 20): string {
  const by = (key: (h: Hit) => string) => {
    const m = new Map<string, number>()
    for (const h of hits) m.set(key(h), (m.get(key(h)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }
  const rows = (r: [string, number][]) => r.map(([k, n]) => `${String(n).padStart(6)}  ${k}`).join('\n')
  const pk = new Map<string, Map<string, number>>()
  for (const h of hits) {
    const m = pk.get(pkgOf(h.file)) ?? new Map<string, number>()
    m.set(h.rule, (m.get(h.rule) ?? 0) + 1)
    pk.set(pkgOf(h.file), m)
  }
  const perPkg = [...pk].map(
    ([p, m]) =>
      `${String([...m.values()].reduce((a, b) => a + b, 0)).padStart(6)}  ${p}  (${[...m].map(([r, n]) => `${r} ${n}`).join(', ')})`,
  )
  return `total ${hits.length}\n\nby rule\n${rows(by((h) => h.rule))}\n\nby package\n${perPkg.sort((a, b) => Number(b.trim().split(/\s/)[0]) - Number(a.trim().split(/\s/)[0])).join('\n')}\n\ntop ${top} files\n${rows(by((h) => h.file).slice(0, top))}`
}

export function main(argv: string[]): number {
  let base = ''
  let strict = false
  let sum = false
  let root = process.cwd()
  const paths: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--changed') base = argv[++i] ?? ''
    else if (a === '--strict') strict = true
    else if (a === '--summary') sum = true
    else if (a === '--root') root = argv[++i] ?? root
    else paths.push(a)
  }
  if (argv.includes('--changed') && !base) {
    console.error('timing-lint: --changed needs a base ref')
    return 2
  }
  const hits = base
    ? lintChanged(root, base, { strict })
    : lintFiles(root, paths.length ? paths : git(root, ['ls-files']).split('\n').filter(Boolean), { strict })
  if (sum) console.log(summary(hits))
  else for (const h of hits) console.log(format(h))
  const fails = hits.filter((h) => !h.warn)
  const skips = fails.filter((h) => h.rule === 'unreasoned-skip')
  if (skips.length > 0 && base) {
    console.error(
      `\nskip lint: ${skips.length} skipped test(s) on added or changed lines do not say why.\n  Fix: ${SKIP_HINT}.`,
    )
  }
  if (fails.length > skips.length && base) {
    console.error(
      `\ntiming lint: ${fails.length - skips.length} hit(s) on added or changed lines. A test that waits a fixed time fails on a loaded machine (TALOS_TEST_TIME_FACTOR is 3 on a small one).\n` +
        "  Fix: wrap the wait in t() from @talos-app/testkit (scripts/: scaled() from packages/testkit/src/time-factor.ts), or raise the test's timeout above the sum of its waits.\n" +
        '  Allow: when the time is the behaviour under test (a negative window, a product deadline), put `// timing-ok: <reason>` on that line or the line above it. The reason must not be empty.',
    )
  }
  return fails.length > 0 ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
