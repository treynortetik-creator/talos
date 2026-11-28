// The structural check behind test-bridge-spawn.test.ts: every call that starts the real bridge (src/server.ts) or its CLI
// (src/cli.ts) takes its env from bridgeChildEnv. Each call is judged by its OWN arguments and env, not by a line window around it and
// not by whether the file calls bridgeChildEnv somewhere: one good spawn in a file does not clear the others. A command built in a
// variable above the call (`const argv = [...]`, `const ENTRY = join(..., 'server.ts')`) is found through that variable's declaration.

/** The spawners it knows: Node's and Bun's, fork, exec, execa, and Bun's shell. `new FakeClaude(` is not one: it makes its env inside. */
const SPAWNERS = [
  'Bun\\.spawnSync',
  'Bun\\.spawn',
  'Bun\\.\\$',
  'child_process\\.\\w+',
  'cp\\.(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)',
  'spawnSync',
  'spawn',
  'execFileSync',
  'execFile',
  'execSync',
  'exec',
  'fork',
  'execa',
  'StdioClientTransport',
]
const BASE_NAMES = ['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync', 'exec', 'execSync', 'execa']

/** Words that make a call a bridge or CLI spawn: the entry files, their usual constants, and the usual name of the CLI path. */
const BRIDGE_WORD = /src[\\/](?:server|cli)\.ts|['"](?:server|cli)\.ts['"]|\b(?:BRIDGE_SERVER|BRIDGE_CLI|CLI)\b/

/** Words that say a value is a throw-away folder of the test's own, or comes from a helper that makes one. */
const TEST_FOLDER_WORD =
  /\b(?:mkdtemp(?:Sync)?|tempHome|testTempDir|makeRoot|tmpdir|runTmp|bridgeChildEnv|ChronosBox|macHome|files|world|[sS]andbox)\b/

/** Position of the `)` / `]` / `}` that closes the bracket at `open`, or -1. Knows quotes, template strings and escapes; not regex literals. */
function closeParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

type Decl = { name: string; pos: number; expr: string }
type Decls = Decl[]

/** The declaration of `name` nearest before `pos`: the one that is in scope for a use there (a name is reused across a file). */
function declOf(decls: Decls, name: string, pos: number): Decl | undefined {
  let found: Decl | undefined
  for (const d of decls) if (d.name === name && d.pos < pos && (!found || d.pos > found.pos)) found = d
  return found
}

/** Every `const|let|var <name | [a, b] | { a, b }> = <expression>` in the file, with where it is. */
function declarations(text: string): Decls {
  const out: Decls = []
  for (const m of text.matchAll(/\b(?:const|let|var)\s+/g)) {
    let i = (m.index as number) + m[0].length
    let pattern: string
    if (text[i] === '[' || text[i] === '{') {
      const close = closeParen(text, i)
      if (close < 0) continue
      pattern = text.slice(i, close + 1)
      i = close + 1
    } else {
      const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0]
      if (!id) continue
      pattern = id
      i += id.length
    }
    const eq = /^\s*(?::[^=]+)?=(?!=)\s*/.exec(text.slice(i))
    if (!eq) continue
    const start = i + eq[0].length
    let depth = 0
    let end = start
    for (; end < text.length; end++) {
      const c = text[end] as string
      if (c === "'" || c === '"' || c === '`') {
        for (end++; end < text.length && text[end] !== c; end++) if (text[end] === '\\') end++
      } else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth < 0) break
      } else if (depth === 0 && (c === ';' || c === '\n')) break
    }
    const expr = text.slice(start, end)
    for (const id of pattern.match(/[A-Za-z_$][\w$]*/g) ?? []) out.push({ name: id, pos: m.index as number, expr })
  }
  return out
}

const identifiers = (s: string): string[] => [
  ...new Set(s.replace(/\/\/.*$/gm, '').match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []),
]

/** `s` (used at `pos`) and, through the declarations of the names in it (a few hops), the text those names stand for. */
function expand(s: string, decls: Decls, pos: number, hops = 4): string {
  let all = s
  let frontier: Array<{ text: string; pos: number }> = [{ text: s, pos }]
  const seen = new Set<string>()
  for (let h = 0; h < hops; h++) {
    const next: Array<{ text: string; pos: number }> = []
    for (const f of frontier)
      for (const id of identifiers(f.text)) {
        const d = declOf(decls, id, f.pos)
        if (!d || seen.has(`${id}@${d.pos}`)) continue
        seen.add(`${id}@${d.pos}`)
        next.push({ text: d.expr, pos: d.pos })
        all += `\n${d.expr}`
      }
    if (!next.length) break
    frontier = next
  }
  return all
}

/** The expression after `env:` inside `args` (up to the `,` or `}` that ends it at its own depth), or null when there is no env. */
function envExpression(args: string): string | null {
  // `{ env }` / `{ cwd, env, stdout }`: the value is the variable of that name
  if (!/(?<![\w.])env\s*:/.test(args) && /[{,]\s*env\s*[,}]/.test(args)) return 'env'
  const m = /(?<![\w.])env\s*:\s*/.exec(args)
  if (!m) return null
  return valueAt(args, m.index + m[0].length)
}

/** The expression that starts at `start` and ends at the `,` or `}` that closes it at its own depth. */
function valueAt(s: string, start: number): string {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i] as string
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === '}') {
      if (depth === 0) return s.slice(start, i).trim()
      depth--
    } else if (c === ',' && depth === 0) return s.slice(start, i).trim()
  }
  return s.slice(start).trim()
}

const fromHelper = (expr: string, text: string): boolean => {
  if (/\bbridgeChildEnv\(/.test(expr)) return true
  // `env: child.env` / `env: child`, with `const child = bridgeChildEnv(` (or `const { env } = bridgeChildEnv(`) in the same file
  const id = /^([A-Za-z_$][\w$]*)(?:\.env)?$/.exec(expr)?.[1]
  if (!id) return false
  const decl = new RegExp(
    `(?:const|let|var)\\s+(?:${id}|\\{[^}]*\\b${id}\\b[^}]*\\})\\s*=\\s*(?:await\\s+)?bridgeChildEnv\\(`,
  )
  return decl.test(text)
}

/** The text of `const NAME = { ... }` in the file (its literal), or null. */
function literalOf(name: string, text: string): string | null {
  const m = new RegExp(`(?:const|let|var)\\s+${name}(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\{`).exec(text)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const close = closeParen(text, open)
  return close < 0 ? null : text.slice(open, close + 1)
}

/** Is this the whole process env: `process.env`, `{ ...process.env }`, `Object.assign({}, process.env)`, a clone of it? One variable of it is not. */
const wholeEnv = (e: string): boolean =>
  /^\s*process\.env\s*$/.test(e) ||
  /\.\.\.\s*process\.env\b/.test(e) ||
  /Object\.assign\([^)]*process\.env\b/.test(e) ||
  /structuredClone\(\s*process\.env/.test(e)

/** Does this env literal copy the process env: a spread of it, or of a name that holds it (`const base = process.env`, however many hops)? */
function copiesProcessEnv(lit: string, decls: Decls, pos: number): boolean {
  if (wholeEnv(lit)) return true
  for (const m of lit.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    const d = declOf(decls, m[1] as string, pos)
    if (d && (wholeEnv(d.expr) || copiesProcessEnv(d.expr, decls, d.pos))) return true
  }
  return false
}

/**
 * An env of the call's own making: a literal whose HOME is a throw-away folder of the test's own (from mkdtemp, a temp-home helper,
 * bridgeChildEnv or a known test root) and that does not copy the process env, directly or through a spread name. Such a child has
 * no real HOME to fall back on. A HOME key alone proves nothing: `HOME: realHome` is refused.
 */
function ownHome(expr: string, text: string, decls: Decls, pos: number): boolean {
  const lit = /^[A-Za-z_$][\w$]*$/.test(expr) ? literalOf(expr, text) : expr.startsWith('{') ? expr : null
  if (lit === null || copiesProcessEnv(lit, decls, pos)) return false
  const m = /\bHOME\s*:\s*/.exec(lit)
  if (!m) return false
  const value = valueAt(lit, m.index + m[0].length)
  if (/\bprocess\.env\b/.test(value)) return false
  if (TEST_FOLDER_WORD.test(expand(value, decls, pos))) return true
  // a parameter typed as a test helper's result: `sb: ReturnType<typeof sandbox>`, `sb: Sandbox`
  return identifiers(value).some((id) =>
    new RegExp(String.raw`\b${id}\s*:\s*[^,)=]*${TEST_FOLDER_WORD.source}`).test(text),
  )
}

/**
 * Files allowed to start the bridge with an env that is none of the above, each with the reason it is safe. Such a file is not
 * scanned for env at all, so the reason has to say why.
 */
export const OWN_HOME_ALLOWED: Record<string, string> = {
  'e2e/sandbox/up.ts':
    'the sandbox launcher builds a whole throw-away machine; its real-claude mode runs with the owner’s HOME on purpose, by design',
}

/** The top-level arguments of a call that are not an object literal (`{ cwd, env }`): the command and its arguments. */
function positional(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  const flush = (end: number) => {
    const part = args.slice(start, end).trim()
    if (part && !part.startsWith('{')) out.push(part)
  }
  for (let i = 0; i < args.length; i++) {
    const c = args[i] as string
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < args.length && args[i] !== c; i++) if (args[i] === '\\') i++
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      flush(i)
      start = i + 1
    }
  }
  flush(args.length)
  return out
}

/** The names the file imports or destructures a spawner under (`spawn as sp`, `{ spawn: sp }`). */
function aliasesOf(text: string): string[] {
  const out: string[] = []
  const names = BASE_NAMES.join('|')
  for (const m of text.matchAll(new RegExp(`\\b(?:${names})\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g')))
    out.push(m[1] as string)
  for (const m of text.matchAll(new RegExp(`\\b(?:${names})\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}]`, 'g')))
    out.push(m[1] as string)
  return out
}

/** Every call in `text` that starts the bridge or its CLI without an env from bridgeChildEnv: `file:line: what`. */
export function scanSource(
  text: string,
  file: string,
  allowed: Record<string, string> = OWN_HOME_ALLOWED,
): { bad: string[]; seen: number } {
  const bad: string[] = []
  let seen = 0
  if (allowed[file] !== undefined) return { bad, seen }
  const decls = declarations(text)
  const alias = aliasesOf(text).map((a) => a.replaceAll('$', '\\$'))
  // a function the file defines itself under one of these names is not the spawner
  const own = new Set(
    [...text.matchAll(/\bfunction\s+(\w+)\s*\(|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?[^=;]*=>/g)].map(
      (m) => (m[1] ?? m[2]) as string,
    ),
  )
  const call = new RegExp(`(?<![\\w.$])(${[...SPAWNERS, ...alias].join('|')})(?=\\(|\`)`, 'g')
  const lineOf = (i: number) => text.slice(0, i).split('\n').length
  for (const m of text.matchAll(call)) {
    const name = m[1] as string
    if (own.has(name)) continue
    const at = m.index as number
    let args: string
    if (name === 'Bun.$') {
      // a template: the command is the string, the env a `.env(` on the same statement
      const open = text.indexOf('`', at)
      let end = open + 1
      for (; end < text.length && text[end] !== '`'; end++) if (text[end] === '\\') end++
      const rest = /^(?:\s*\.\w+\([^)]*\))*/.exec(text.slice(end + 1))?.[0] ?? ''
      const envCall = /\.env\(([\s\S]*)\)/.exec(rest)?.[1]
      args = `${text.slice(open, end + 1)}${envCall !== undefined ? ` env: ${envCall}` : ''}`
    } else {
      const open = at + name.length
      const close = closeParen(text, open)
      if (close < 0) continue
      args = text.slice(open + 1, close)
    }
    // is it the bridge? by its own arguments and, for a name in them, by what that name was declared as (the options object
    // is not the command: its names are not followed)
    const command = positional(args).join(', ')
    if (!BRIDGE_WORD.test(expand(command, decls, at).replace(/\/\/.*$/gm, ''))) continue
    seen++
    const where = `${file}:${lineOf(at)}: ${name}(`
    const env = envExpression(args)
    if (env === null)
      bad.push(`${where} passes no env, so the child inherits the whole process env (and the real HOME)`)
    else if (!fromHelper(env, text) && !ownHome(env, text, decls, at))
      bad.push(`${where} env is not from bridgeChildEnv: ${env.replace(/\s+/g, ' ').slice(0, 60)}`)
  }
  return { bad, seen }
}
