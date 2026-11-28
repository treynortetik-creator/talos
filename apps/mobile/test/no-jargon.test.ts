// gate-reads: apps/mobile/ios/*.swift apps/mobile/ios/*.strings apps/mobile/ios/*Info.plist apps/mobile/ios/*project.yml
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The owner reads the iPhone app's words, so they carry no engineer terms (the web app had the same pass). This scans the
// owner-facing Swift and plist sources for a string literal that says relay, bridge, session(s), MCP, daemon, tmux, pty,
// supervisor, worker or token(s) (a "sign-in token" is allowed). The glossary: relay -> "Talos server", bridge -> "your Mac",
// session/worker -> "agent", tokens -> "sign-in code" or "link". Not scanned: comments, log calls, identifiers, keys, URLs
// (a literal with no space), test targets, and DEBUG-only code. The few lines below are on purpose; each says why, and a
// test fails when one stops matching anything, so the list cannot go stale.
const IOS = fileURLToPath(new URL('../ios/', import.meta.url))

const BANNED = /\b(talos online|relay|bridge|sessions?|mcp|daemon|tmux|pty|supervisor|worker|(?<!sign-in )tokens?)\b/i

type Skip = { file: RegExp; line: RegExp; why: string }
const ALLOWED: Skip[] = [
  {
    file: /\/Plugins\/Talos(Push|Share)\.swift$/,
    line: /call\.reject\(/,
    why: 'a rejection code handed to the page code, which words its own message; it is never shown as written',
  },
  {
    file: /\/Plugins\/TalosAudio\.swift$/,
    line: /call\.reject\(/,
    why: 'a rejection code handed to the page code, never shown as written',
  },
  {
    file: /\/AudioSessionPolicy\.swift$/,
    line: /onWarning\?\(/,
    why: 'a warning that goes to the log; the audio session is the iOS audio API, not a Talos session',
  },
  // Kept quotes of Mac-app labels (apps/desktop, Delphi's) go here with the exact text and the reason. None today: the iPhone
  // app quotes only the terminal commands "talos-app enroll" and "talos-app rotate", which the Mac shows as commands too.
]

/** Whole files left out, with the reason. A test checks each still exists. */
const SKIPPED_FILES: Record<string, string> = {
  'App/App/Relay/DebugAddRelay.swift': 'a debug-only hook (launch arguments in the simulator); no owner sees it',
}

const LOG = /(CAPLog|NSLog|Logger|logger|os_log|\bprint\(|debugDescription:)/

/** Every `"..."` literal on a line that is not inside a trailing `//` comment, with `\(...)` holes and `\n` made plain. */
function literals(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '/' && line[i + 1] === '/') break
    if (c === '"') {
      let j = i + 1
      let depth = 0
      let text = ''
      while (j < line.length && (line[j] !== '"' || depth > 0)) {
        if (line[j] === '\\') {
          if (line[j + 1] === '(') {
            depth++
            j += 2
            continue
          }
          if (depth === 0) text += ' '
          j += 2
          continue
        }
        if (depth > 0) {
          if (line[j] === '(') depth++
          else if (line[j] === ')') depth--
        } else text += line[j]
        j++
      }
      out.push(text)
      i = j + 1
      continue
    }
    i++
  }
  return out
}

/** A literal a person reads: it has a space. A key, a path or a URL does not. */
const isProse = (s: string): boolean => /\s/.test(s.trim()) || /^[A-Z][a-z]+$/.test(s)

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.build' || e.name === 'Tests' || e.name.endsWith('Tests') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(swift|strings)$/.test(e.name) || e.name === 'Info.plist' || e.name === 'project.yml') out.push(p)
  }
  return out
}

/** The pieces of text on one line. `multi` is true while inside a `"""` block that carries over from the previous line. */
function pieces(line: string, multi: boolean): { texts: string[]; multi: boolean } {
  const texts: string[] = []
  let rest = line
  if (multi) {
    const end = rest.indexOf('"""')
    texts.push(literalHoles(end < 0 ? rest : rest.slice(0, end)))
    if (end < 0) return { texts, multi: true }
    rest = rest.slice(end + 3)
  }
  const open = rest.indexOf('"""')
  if (open < 0) return { texts: [...texts, ...literals(rest)], multi: false }
  texts.push(...literals(rest.slice(0, open)))
  const after = rest.slice(open + 3)
  const close = after.indexOf('"""')
  texts.push(literalHoles(close < 0 ? after : after.slice(0, close)))
  return { texts, multi: close < 0 }
}

/** Text with `\(...)` holes and escapes made plain. */
const literalHoles = (s: string): string => literals(`"${s.replace(/"/g, '\\"')}"`)[0] ?? ''

/** A single plain word, like "relay": a key or a piece of a sentence built with `+`. */
const bareWord = (s: string): boolean => /^[A-Za-z][A-Za-z-]*$/.test(s)

/** The prose strings with a banned word in one Swift source, as `{ n: line number, raw: the line, text }`. */
function scanSource(src: string): { n: number; raw: string; text: string }[] {
  const hits: { n: number; raw: string; text: string }[] = []
  // One entry per open #if: `debug` is true while the branch being read is the DEBUG-only one.
  const stack: { debugIf: boolean; negated: boolean; debug: boolean }[] = []
  let multi = false
  let prevPlus = false
  src.split('\n').forEach((raw, n) => {
    const line = raw.trim()
    if (!multi) {
      const cond = line.match(/^#if\s+(!?)\s*DEBUG\s*$/)
      if (cond) {
        stack.push({ debugIf: true, negated: cond[1] === '!', debug: cond[1] !== '!' })
        return
      }
      if (/^#if\b/.test(line)) {
        stack.push({ debugIf: false, negated: false, debug: false })
        return
      }
      if (/^#(else|elseif)\b/.test(line)) {
        const top = stack[stack.length - 1]
        // After `#if DEBUG` the other branches are release code; after `#if !DEBUG` the `#else` is the debug one.
        if (top?.debugIf) top.debug = top.negated && /^#else\b/.test(line)
        return
      }
      if (/^#endif\b/.test(line)) {
        stack.pop()
        return
      }
    }
    const skipping = stack.some((e) => e.debug)
    if (!multi && line.startsWith('//')) return
    const p = pieces(raw, multi)
    multi = p.multi
    const concat = prevPlus || /(^|[^+])\+(?!\+)/.test(raw.replace(/"(?:[^"\\]|\\.)*"/g, '""'))
    if (line !== '') prevPlus = /\+\s*$/.test(raw)
    if (skipping) return
    for (const t of p.texts) {
      if ((isProse(t) || (concat && bareWord(t.trim()))) && BANNED.test(t)) hits.push({ n: n + 1, raw, text: t })
    }
  })
  return hits
}

type Hit = { where: string; text: string }
const used = new Set<Skip>()

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const file of walk(IOS)) {
    const rel = relative(IOS, file)
    if (rel in SKIPPED_FILES) continue
    const src = readFileSync(file, 'utf8')
    let found: { n: number; raw: string; text: string }[] = []
    if (file.endsWith('.swift')) found = scanSource(src)
    else {
      src.split('\n').forEach((raw, n) => {
        const line = raw.trim()
        const m = file.endsWith('.plist')
          ? line.match(/^<string>(.*)<\/string>$/)
          : line.match(/^NS\w+UsageDescription:\s*(.+)$/)
        if (m && isProse(m[1]) && BANNED.test(m[1])) found.push({ n: n + 1, raw, text: m[1] })
      })
    }
    for (const f of found) {
      if (LOG.test(f.raw)) continue
      const skip = ALLOWED.find((a) => a.file.test(`/${rel}`) && a.line.test(f.raw))
      if (skip) {
        used.add(skip)
        continue
      }
      hits.push({ where: `${rel}:${f.n}`, text: f.text })
    }
  }
  return hits
}

describe('the iPhone app says no engineer words to the owner', () => {
  const hits = scan()
  it('scans the Swift, plist and yml sources', () => expect(walk(IOS).length).toBeGreaterThan(30))
  it('has no banned word in a string a person reads', () => {
    expect(hits.map((h) => `${h.where}  ${h.text}`)).toEqual([])
  })
  it('skips only files that exist', () => {
    for (const f of Object.keys(SKIPPED_FILES)) expect(walk(IOS).map((p) => relative(IOS, p))).toContain(f)
  })
  it('keeps no allowlist line that matches nothing', () => {
    expect(ALLOWED.filter((a) => !used.has(a)).map((a) => a.why)).toEqual([])
  })
  it('scans the #else branch of #if DEBUG, #elseif and nested #if', () => {
    const src = [
      '#if DEBUG',
      'a("debug relay text")',
      '#else',
      'b("release relay text")',
      '#endif',
      '#if DEBUG',
      '#if os(iOS)',
      'c("nested debug relay text")',
      '#endif',
      'd("still debug relay text")',
      '#elseif os(macOS)',
      'e("elseif relay text")',
      '#else',
      'f("else relay text")',
      '#endif',
      '#if !DEBUG',
      'g("release only relay text")',
      '#else',
      'h("debug only relay text")',
      '#endif',
    ].join('\n')
    expect(scanSource(src).map((h) => h.text)).toEqual([
      'release relay text',
      'elseif relay text',
      'else relay text',
      'release only relay text',
    ])
  })
  it('scans the body of a multi-line string', () => {
    const src = ['let a = """', '  Your relay is busy.', '  Try \\(x) later.', '  """', 'let b = "relay"'].join('\n')
    expect(scanSource(src).map((h) => h.text.trim())).toEqual(['Your relay is busy.'])
  })
  it('catches a banned word alone in a concatenated piece', () => {
    expect(scanSource('x("Remove this " + "relay")').map((h) => h.text)).toEqual(['relay'])
    expect(scanSource('x("Remove this " +\n  "relay")').map((h) => h.text)).toEqual(['relay'])
    expect(scanSource('let key = "relay"')).toEqual([])
  })
  it('catches a banned word, an interpolation and a sign-in token', () => {
    expect(literals('x("Add your relay \\(bridge)\\nNext")')).toEqual(['Add your relay  Next'])
    expect(BANNED.test('Add your relay')).toBe(true)
    expect(BANNED.test('a sign-in token')).toBe(false)
    expect(BANNED.test('the share token')).toBe(true)
    expect(literals('let a = 1 // "relay here"')).toEqual([])
  })
  it('catches "Talos online": the server has one name, "Talos server" (the lead, 2026-11-20)', () => {
    expect(scanSource('x("Talos online is not answering.")').map((h) => h.text)).toEqual([
      'Talos online is not answering.',
    ])
    expect(scanSource('x("The Talos server is not answering.")')).toEqual([])
  })
})
