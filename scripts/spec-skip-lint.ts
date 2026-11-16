// The browser specs' skips must not depend on the machine (docs/CI-MACHINES.md, "browser in two places"). Once the browser job
// runs on Titan (Linux), a test skipped there and tagged nowhere runs nowhere, and nothing counts it: a runtime skip is still in
// `playwright test --list`. So a skip or fixme in a *.spec.ts may not be keyed on the platform, the host name, a CI variable or
// WSL. A test that only holds on a Mac takes the @mac-only tag instead, which is counted and run on a Mac.
//
// A text scan, not a type check: it reads the condition of every `.skip(` and `.fixme(` call, the `if` around a bare one, and one
// level of a local `const` the condition names. A helper imported from another file is caught only by its name (onLinux, isWsl,
// ...). Playwright configs (grepInvert, testIgnore) are a reviewer's read, not this scan's.

export type SkipFinding = { line: number; text: string; why: string }

const RULES: [RegExp, string][] = [
  [/process\.platform|\bos\.platform\s*\(|\bplatform\s*\(\s*\)|['"`](linux|darwin|win32)['"`]/, 'the platform'],
  [/\bhostname\s*\(|\bHOSTNAME\b|\bCOMPUTERNAME\b/, 'the host name'],
  [
    /\benv\s*\.\s*(CI|CI_\w+|GITHUB_\w+|RUNNER_\w+|TALOS_MACHINE|TALOS_CI\w*)\b|\benv\s*\[\s*['"`](CI|CI_\w*|GITHUB_\w+|RUNNER_\w+|TALOS_MACHINE|TALOS_CI\w*)['"`]/,
    'a CI variable',
  ],
  [/\bWSL\w*|\bwsl\b|microsoft|\/proc\/version|\bos\.release\s*\(|\brelease\s*\(\s*\)/i, 'WSL'],
]
// names of helpers that usually carry one of the above
const NAMES = /^(is|on|in|not)?_?(linux|wsl|platform|hostname|ci|runner|machine|titan|lemnos|delphi|mac|darwin)\w*$/i

/** The index just past the bracket matching the one at `open` ((, { or [), skipping strings, templates and comments. */
function closeOf(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = [pairs[src[open] as string] as string]
  let i = open + 1
  while (i < src.length && stack.length) {
    const c = src[i] as string
    if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i)
    else if (c === '/' && src[i + 1] === '*')
      i = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 2
    else if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      i++
    } else {
      if (c in pairs) stack.push(pairs[c] as string)
      else if (c === stack[stack.length - 1]) stack.pop()
      i++
    }
  }
  return i
}

/** Top-level comma-separated parts of an argument list (without its brackets). */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (c === '(' || c === '{' || c === '[') i = closeOf(s, i)
    else if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < s.length && s[i] !== c) i += s[i] === '\\' ? 2 : 1
      i++
    } else if (c === ',') {
      out.push(s.slice(start, i).trim())
      start = ++i
    } else i++
  }
  if (s.slice(start).trim()) out.push(s.slice(start).trim())
  return out
}

const isString = (a: string) => /^(['"`])[\s\S]*\1$/.test(a)
const isFunction = (a: string) => /^(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(a)

/** Why a condition is keyed on the machine, or '' when it is not. Follows local consts it names, two levels deep. */
function keyedOn(cond: string, src: string, depth = 0): string {
  for (const [re, why] of RULES) if (re.test(cond)) return why
  const ids = cond.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '').match(/[A-Za-z_$][\w$]*/g) ?? []
  for (const id of new Set(ids)) {
    if (NAMES.test(id)) return `a helper named ${id}`
    if (depth >= 2) continue
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=`).exec(src)
    if (!decl) continue
    const from = decl.index + decl[0].length
    const end = src.indexOf('\n', from)
    const why = keyedOn(src.slice(from, end === -1 ? src.length : end), src, depth + 1)
    if (why) return why
  }
  return ''
}

const lineOf = (src: string, i: number) => src.slice(0, i).split('\n').length

/** Every skip or fixme in a spec file keyed on the machine. */
export function machineSkips(src: string): SkipFinding[] {
  const found: SkipFinding[] = []
  const add = (at: number, why: string) => {
    const line = lineOf(src, at)
    found.push({ line, text: (src.split('\n')[line - 1] ?? '').trim(), why })
  }
  // calls: test.skip(cond), test.skip(cond, why), test.skip(({ ... }) => cond, why), test.describe.fixme(...)
  for (const m of src.matchAll(/\.(skip|fixme)\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1
    const args = splitArgs(src.slice(open + 1, closeOf(src, open) - 1))
    // test.skip('title', () => {...}): a test skipped everywhere, not by a condition
    if (args.length >= 2 && isString(args[0] as string) && isFunction(args[1] as string)) continue
    const conds = args.filter((a) => !isString(a))
    const why = conds.map((c) => keyedOn(c, src)).find(Boolean)
    if (why) add(m.index as number, why)
  }
  // a bare one under an if: if (process.platform === 'linux') test.skip()
  for (const m of src.matchAll(/\bif\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1
    const close = closeOf(src, open)
    const cond = src.slice(open + 1, close - 1)
    let j = close
    while (/\s/.test(src[j] ?? '')) j++
    const body =
      src[j] === '{'
        ? src.slice(j, closeOf(src, j))
        : src.slice(j, src.indexOf('\n', j) === -1 ? src.length : src.indexOf('\n', j))
    if (!/\.(skip|fixme)\s*\(/.test(body)) continue
    const why = keyedOn(cond, src)
    if (why) add(m.index as number, why)
  }
  // cond && test.skip(...)
  for (const m of src.matchAll(/^.*?&&\s*[\w$.]*\.(skip|fixme)\s*\(/gm)) {
    const why = keyedOn(m[0].replace(/&&\s*[\w$.]*\.(skip|fixme)\s*\($/, ''), src)
    if (why && !found.some((f) => f.line === lineOf(src, m.index as number))) add(m.index as number, why)
  }
  return found
}
