// Shared helpers for scripts/verify (the verify skill's smoke harness): argument parsing, evidence names, the evidence index,
// WCAG contrast, the font-identity check, the theme list read from code, and a command runner whose time limit stops the
// whole process group. No browser and no network in here, so the unit test (lib.test.ts) runs everywhere.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Exit codes: 0 all good, 1 an expectation failed, 2 bad usage, 3 a surface could not be reached (never skipped quietly). */
export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 }

export class Usage extends Error {}
export class Unreachable extends Error {}

export function evidenceRoot(env = process.env) {
  // the macOS folder every account can write (the owner's choice); joined, not typed out, because the personal-data check refuses a literal /Users/<name>
  return env.TALOS_VERIFY_EVIDENCE_ROOT || ['', 'Users', 'Shared', 'talos-verify-evidence'].join('/')
}

const SAFE = /^[a-z0-9][a-z0-9-]*$/
export function safePart(what, v) {
  if (typeof v !== 'string' || !SAFE.test(v))
    throw new Usage(`${what} "${v}" must be lowercase letters, digits and dashes`)
  return v
}

/** <surface>-<route>-<theme>-<before|after>.<ext>; the evidence folder is named by the short sha. */
export function captureName({ surface, route, theme, label, ext }) {
  safePart('surface', surface)
  safePart('route', route)
  safePart('theme', theme)
  if (label !== 'before' && label !== 'after') throw new Usage(`label "${label}" must be before or after`)
  if (!/^(png|mp4|txt)$/.test(ext)) throw new Usage(`ext "${ext}" must be png, mp4 or txt`)
  return `${surface}-${route}-${theme}-${label}.${ext}`
}

/** Flags: `--name value` or `--name=value` (repeatable flags collect an array); the first bare word is the command. */
export function parseArgs(argv, { repeatable = [], booleans = [] } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (booleans.includes(name)) {
      out[name] = true
      continue
    }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1)
    if (value === undefined) throw new Usage(`--${name} needs a value`)
    if (repeatable.includes(name)) {
      out[name] = [...(out[name] ?? []), value]
    } else out[name] = value
  }
  return out
}

// ---- WCAG 2.x contrast (what the skill's colour check measures) ---------------------------------------------------------

/** "rgb(r, g, b)" / "rgba(r, g, b, a)" / "#rrggbb" to [r, g, b, a]; null when it is none of those (a named or color() value). */
export function parseColour(s) {
  const t = String(s).trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(t)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(t)
  if (!m) return null
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4])
  return [Number(m[1]), Number(m[2]), Number(m[3]), a]
}

const lin = (c) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Lays a translucent colour over an opaque one. */
export const over = ([r, g, b, a], [br, bg, bb]) => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
  1,
]

/**
 * One text sample {label, fg, bg, px, weight} against WCAG AA: 4.5, or 3 for large text (24 px, or 18.66 px and bold).
 * A colour the check cannot read is a FAIL with the reason, never a pass.
 */
export function judgeContrast({ label, fg, bg, px, weight }) {
  const f = parseColour(fg)
  const b = parseColour(bg)
  if (!f || !b) return { label, ok: false, ratio: null, need: null, note: `cannot read colours (${fg} on ${bg})` }
  const bgSolid = b[3] < 1 ? over(b, [255, 255, 255]) : b
  const solid = over(f, bgSolid)
  const large = px >= 24 || (px >= 18.66 && Number(weight) >= 700)
  const need = large ? 3 : 4.5
  const ratio = contrastRatio(solid, bgSolid)
  return { label, ok: ratio >= need, ratio: Math.round(ratio * 100) / 100, need, note: large ? 'large text' : '' }
}

/**
 * Fonts must be identical in every theme: `byTheme` is {theme: {target: computed font-family}}. Returns one finding per target
 * whose value is not the same everywhere (an empty list is a pass). A target present in only some themes is a finding too.
 */
export function fontDifferences(byTheme) {
  const themes = Object.keys(byTheme)
  const targets = new Set(themes.flatMap((t) => Object.keys(byTheme[t])))
  const out = []
  for (const target of targets) {
    const values = themes.map((t) => byTheme[t][target] ?? '(missing)')
    if (new Set(values).size > 1) out.push({ target, values: Object.fromEntries(themes.map((t, i) => [t, values[i]])) })
  }
  return out
}

/** The theme ids the app lists, read from the worktree's own protocol source (never a hard-coded list). */
export async function listThemes(worktree) {
  const file = join(worktree, 'packages/protocol/src/theme.ts')
  if (!existsSync(file)) throw new Unreachable(`no ${file}: is --worktree a Talos checkout?`)
  const m = await import(pathToFileURL(file).href)
  if (!Array.isArray(m.STOCK_THEME_IDS) || m.STOCK_THEME_IDS.length === 0)
    throw new Unreachable(`${file} exports no STOCK_THEME_IDS: the theme list moved, update scripts/verify/lib.mjs`)
  return [...m.STOCK_THEME_IDS]
}

// ---- the evidence index ----------------------------------------------------------------------------------------------

/** index.json keeps the records; index.md is rendered from it each time, so before and after runs add to one list. */
export function loadIndex(dir) {
  const f = join(dir, 'index.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { title: '', routeList: '', captures: [] }
}

export function saveIndex(dir, index) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  writeFileSync(join(dir, 'index.md'), renderIndex(index))
}

/** Replaces a record with the same file name (a re-run), else appends. */
export function addCapture(index, rec) {
  const i = index.captures.findIndex((c) => c.file === rec.file)
  if (i === -1) index.captures.push(rec)
  else index.captures[i] = rec
  return index
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')

export function renderIndex(index) {
  const lines = [`# Verify evidence ${index.title || ''}`.trim(), '']
  lines.push(
    '## Route list',
    '',
    index.routeList?.trim() || '(none written: the run that made this index was refused)',
    '',
  )
  lines.push(
    '## Captures',
    '',
    '| file | surface | route | theme | when | tree | result | proves |',
    '|---|---|---|---|---|---|---|---|',
  )
  for (const c of index.captures)
    lines.push(
      `| ${cell(c.file)} | ${cell(c.surface)} | ${cell(c.route)} | ${cell(c.theme)} | ${cell(c.label)} | ${cell(c.tree)} | ${cell(c.result)} | ${cell(c.proves)} |`,
    )
  lines.push('')
  const facts = index.captures.filter((c) => c.facts && Object.keys(c.facts).length > 0)
  if (facts.length > 0) {
    lines.push('## Measured facts', '')
    for (const c of facts) lines.push(`- ${c.file}: \`${JSON.stringify(c.facts)}\``)
    lines.push('')
  }
  if (index.findings?.length) {
    lines.push('## Findings', '', ...index.findings.map((f) => `- ${f}`), '')
  }
  return `${lines.join('\n')}\n`
}

// ---- running commands ------------------------------------------------------------------------------------------------

/**
 * Runs a command in its own process group and, at the limit, stops the whole group (TERM, then KILL after 5 s). Resolves
 * {code, signal, timedOut, stdout, stderr}; never throws for a non-zero exit. `pid` is passed to onStart so a caller can track it.
 */
export function runGroup(cmd, args, { cwd, env, timeoutMs, onStart, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    trackGroup(child.pid)
    onStart?.(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig)
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 5000).unref()
    }, timeoutMs ?? 120_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      untrackGroup(child.pid)
      resolve({ code: 127, signal: null, timedOut, stdout, stderr: `${stderr}${e.message}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      untrackGroup(child.pid)
      kill('SIGKILL') // anything the command left behind in its group
      resolve({ code: code ?? (signal ? 128 : 1), signal, timedOut, stdout, stderr })
    })
  })
}

// ---- interruption ----------------------------------------------------------------------------------------------------
// Every command runs in a process group of its own (so a time limit stops all of it), which means nothing stops it when THIS script
// is stopped. So the groups are written down, and a signal stops each one, runs the cleanups (temp folders, a simulator we booted)
// and exits 128+signal: 130 for Ctrl-C, 143 for a time limit or a closing session.

const groups = new Set()
const cleanups = new Set()

export function trackGroup(pid) {
  if (pid) groups.add(pid)
}
export function untrackGroup(pid) {
  groups.delete(pid)
}
/** A cleanup to run on interruption (sync or async); returns a function that removes it again. */
export function onInterrupt(fn) {
  cleanups.add(fn)
  return () => cleanups.delete(fn)
}

/** Stops every tracked group (and forgets them). Safe to call twice; a group that is already gone is not an error. */
export function killTrackedGroups() {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  groups.clear()
}

export function installSignalCleanup(exit = process.exit) {
  const NUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  let running = false
  for (const [sig, n] of Object.entries(NUM)) {
    process.on(sig, () => {
      if (running) return
      running = true
      killTrackedGroups()
      const pending = [...cleanups].map((fn) => {
        try {
          return Promise.resolve(fn())
        } catch {
          return Promise.resolve()
        }
      })
      // a cleanup that hangs (a browser that will not close) cannot keep the script alive
      Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 4000))]).then(() => {
        killTrackedGroups()
        exit(128 + n)
      })
    })
  }
}
