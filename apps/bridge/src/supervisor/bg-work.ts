// Background work under a thread session's pane (the Mac's BackgroundWork and BackgroundWorkFound.swift; docs/OPTION-C.md, "Idle").
// A session whose turn has ended may still have work running under it: a Bash tool command left in the background, a `sleep` that
// is its own waker. The idle park waits for it and the cap takes a session with none first (worker-slots.ts, worker-cap.ts).
//
// The rule: under claude, a shell claude started (the Bash tool) or another claude is work, with everything under it; claude's MCP
// servers and its own helpers (caffeinate) are not. Under a pane root that is not claude, anything that is not a shell is work.
// Claude Code's native install runs as a file named for its version (`~/.local/share/claude/versions/2.1.325`, reached through the
// `~/.local/bin/claude` link), so the process's own name is "2.1.325" and its argv[0] the link: that is claude too. A sub-agent runs
// inside claude and is not seen by itself, only while a command it started runs.
import { readdirSync, readFileSync } from 'node:fs'

export type Proc = { pid: number; ppid: number; name: string; argv?: string[] | null }
export type BgFound = { count: number; first: string | null }
export const NO_BG: BgFound = { count: 0, first: null }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'nu', 'elvish'])
const RUNTIMES = new Set(['node', 'bun'])

const base = (s: string): string => {
  const b = s.split('/').pop() ?? s
  return b.startsWith('-') ? b.slice(1) : b
}

/** Numbers and dots, at least one dot ("2.1.325"): ASCII digits only. */
export const isVersionName = (s: string): boolean => /^[0-9]+(\.[0-9]+)+$/.test(s)

/** Whether the table reads this process's argv: a runtime that may run claude, or a native install's version name. */
export const wantsArgv = (name: string): boolean => RUNTIMES.has(base(name)) || isVersionName(base(name))

export function isClaude(p: Proc): boolean {
  const n = base(p.name)
  if (n === 'claude') return true
  if (isVersionName(n)) {
    const first = p.argv?.[0]
    return first !== undefined && (base(first) === 'claude' || first.includes('/claude/versions/'))
  }
  if (!RUNTIMES.has(n) || !p.argv) return false
  return p.argv.slice(1, 4).some((a) => a.endsWith('/claude') || a.endsWith('claude-code/cli.js'))
}

export const isShell = (p: Proc): boolean => SHELLS.has(base(p.name))

/** The processes that are work under one pane root, each named once at the top of its own tree. A root that is gone gives none. */
export function offenders(table: Proc[], pane: number): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of table) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  for (const list of kids.values()) list.sort((a, b) => a.pid - b.pid)
  const out: Proc[] = []
  const underClaude = (c: Proc) => {
    for (const k of kids.get(c.pid) ?? []) if (isShell(k) || isClaude(k)) out.push(k)
  }
  const underPane = (p: Proc) => {
    for (const k of kids.get(p.pid) ?? []) {
      if (isClaude(k)) underClaude(k)
      else if (isShell(k)) underPane(k)
      else out.push(k)
    }
  }
  const root = pane > 1 ? table.find((p) => p.pid === pane) : undefined
  if (root) isClaude(root) ? underClaude(root) : underPane(root)
  return out
}

/** The text inside the Bash tool's `eval '...'`, with the shell's `'"'"'` (a quote inside single quotes) put back as `'`. */
export function evalCommand(script: string): string | null {
  const at = script.indexOf("eval '")
  if (at < 0) return null
  let out = ''
  for (let i = at + 6; i < script.length; ) {
    if (script.startsWith(`'"'"'`, i)) {
      out += "'"
      i += 5
    } else if (script[i] === "'") return out
    else out += script[i++]
  }
  return out
}

/** A task's command as one line of at most `limit` characters (the Bash tool's eval'd command, a `-c` script, or the argv). */
export function command(argv: string[] | null | undefined, name: string, limit = 60): string {
  let text = name
  if (argv && argv.length > 0) {
    const c = argv.indexOf('-c')
    const script = c >= 0 ? argv[c + 1] : undefined
    text = script !== undefined ? (evalCommand(script) ?? script) : argv.join(' ')
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
  return [...(flat || name)].slice(0, limit).join('')
}

/** The background work under one pane: how many tasks, and the first one's command. */
export function found(table: Proc[], pane: number, argv: (pid: number) => string[] | null): BgFound {
  const tasks = offenders(table, pane)
  const top = tasks[0]
  return top ? { count: tasks.length, first: command(argv(top.pid) ?? top.argv, top.name) } : NO_BG
}

/** The thread's one line when a park cut its background work. */
export const cutLine = (f: BgFound): string =>
  `Parked while ${f.count} background task(s) were running${f.first ? `: ${f.first}` : ''}.`

/** The thread's one line when it starts over the limit because every quiet session has background work (the Mac's `BackgroundWork.busyLine`). */
export const busyLine =
  'Your computer is busy: other threads still have work running in the background, so this one started anyway and nothing was stopped.'

/** One process's argv from /proc; null when it cannot be read. */
export function procArgv(pid: number, root = '/proc'): string[] | null {
  try {
    const raw = readFileSync(`${root}/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter((a, i, all) => a !== '' || i < all.length - 1)
  } catch {
    return null
  }
}

/**
 * The live process table from /proc (Linux and WSL): pid, parent, the kernel's name, and the argv of the names that may be claude.
 * null when /proc cannot be listed (another system): unknown, never "no work". A process that ends while it is read is left out.
 */
export function procTable(root = '/proc'): Proc[] | null {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  const out: Proc[] = []
  for (const n of names) {
    if (!/^[0-9]+$/.test(n)) continue
    let stat: string
    try {
      stat = readFileSync(`${root}/${n}/stat`, 'utf8')
    } catch {
      continue
    }
    // "<pid> (<comm>) <state> <ppid> ...": the name may hold spaces and parentheses, so it ends at the last ")"
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const name = stat.slice(open + 1, close)
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    if (!Number.isInteger(ppid)) continue
    const pid = Number(n)
    out.push({ pid, ppid, name, argv: wantsArgv(name) ? procArgv(pid, root) : null })
  }
  return out
}
