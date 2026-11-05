// What the guard hook and the permission deny rules protect, and the one function that decides a tool call. Both outputs
// of `talos-app install-guards` come from the same `GuardConfig`, so the hook and the rules never disagree.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { COMMANDS, terminalOnly } from '../talos.ts'

export type GuardConfig = {
  home: string
  checkout: string
  claudeHome: string
  /** The user's own home folder, as `~`, `$HOME` and `${HOME}` in a command mean it. Fixed at install, not read from the environment. */
  userHome: string
  /** Absolute paths from docs/protected-paths.txt in the running checkout. */
  protectedPaths: string[]
  /** Files and folders no tool call may write. */
  writeDenied: string[]
}

export type GuardCall = { tool_name: string; tool_input?: unknown }
export type GuardDeny = { deny: string }

/** The tools that write a file. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export function buildGuardConfig(a: {
  home: string
  checkout: string
  claudeHome: string
  userHome?: string
}): GuardConfig {
  const checkout = real(a.checkout)
  const listed = existsSync(join(checkout, 'docs', 'protected-paths.txt'))
    ? readFileSync(join(checkout, 'docs', 'protected-paths.txt'), 'utf8')
    : ''
  const protectedPaths = listed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => join(checkout, l))
  return {
    home: real(a.home),
    checkout,
    claudeHome: real(a.claudeHome),
    userHome: real(a.userHome ?? homedir()),
    protectedPaths,
    writeDenied: [
      ...protectedPaths,
      checkout,
      join(real(a.home), 'enroll-pending'),
      join(real(a.home), 'guards'),
      join(real(a.home), 'tripwire.json'),
      join(real(a.home), 'tripwire.writing'),
      join(real(a.home), 'devices.json'),
      join(real(a.home), 'config.json'),
      // phone recovery: the request file the Mac app acts on, and the saved setups a restore reads
      join(real(a.home), 'agent-request.json'),
      join(real(a.home), 'last-good'),
      join(real(a.home), 'config-history'),
      join(real(a.claudeHome), 'plugins'),
      join(real(a.claudeHome), 'dev-mods'),
    ],
  }
}

/** realpath of the deepest part that exists, so a symlink or `..` cannot step round a rule. */
export function real(p: string): string {
  let cur = resolve(p)
  const tail: string[] = []
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(cur.slice(dirname(cur).length + 1))
    cur = dirname(cur)
  }
  try {
    cur = realpathSync(cur)
  } catch {}
  return join(cur, ...tail)
}

const under = (p: string, target: string) => p === target || p.startsWith(target + sep)

/** `Edit(//abs/path)` is Claude Code's spelling of an absolute path in a permission rule. */
export function denyRules(cfg: GuardConfig): string[] {
  const edit = cfg.writeDenied.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])
  const gated = COMMANDS.filter((c) => c.needs_terminal).flatMap((c) => [
    `Bash(talos-app ${c.name}:*)`,
    `Bash(talos ${c.name}:*)`,
  ])
  return [
    ...edit,
    ...gated,
    'Bash(claude plugin:*)',
    'Bash(claude plugins:*)',
    'Bash(*action-rules.py approve*)',
    'Bash(*enroll-pending*)',
    'Bash(*agent-request.json*)',
    'Bash(*.claude/plugins*)',
    'Bash(*.claude/dev-mods*)',
  ]
}

/** Files and folders inside the Talos home that no command may name at all. */
const HOME_NEVER = [
  'enroll-pending',
  'guards',
  'guards.json',
  'tripwire.json',
  'tripwire.writing',
  'agent-request.json',
]
/** Files inside the Talos home that a command may read but not write. */
const HOME_READ_ONLY = ['devices.json', 'config.json', 'last-good', 'config-history']
/** Spellings of those names that mean the file wherever the shell is standing (`cd <home> && rm guards.json`). */
const BARE_STEMS = ['guards.json', 'tripwire.json', 'tripwire.writing', 'enroll-pend', 'agent-request.json']

/** Words that run the next command rather than being it. */
const WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'nohup',
  'time',
  'exec',
  'command',
  'builtin',
  'nice',
  'xargs',
  'stdbuf',
  'timeout',
  'caffeinate',
  'script',
  'unbuffer',
  'expect',
  'faketty',
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const RUNNERS = new Set(['bun', 'bunx', 'node', 'deno', 'tsx', 'npx'])
const FAKE_TTY = /\b(?:script|unbuffer|expect|faketty|socat|pexpect|ptyprocess)\b|\bimport\s+pty\b|\bpty\.spawn\b/
const GATED_NAMES = COMMANDS.filter((c) => c.needs_terminal)
  .map((c) => c.name.split(' ')[0])
  .filter((n, i, all) => all.indexOf(n) === i)
  .join('|')
const LOOSE_GATED = new RegExp(`\\b(?:talos-app|talos|cli(?:-main)?(?:\\.ts)?)\\W+(?:${GATED_NAMES})\\b`)
// Verbs that write. Redirections that only discard or merge output (`2>&1`, `>/dev/null`) do not count.
const SHELL_WRITES =
  '>|\\btee\\b|\\bsed\\s+-\\S*i|\\bperl\\s+-\\S*i|\\b(?:mv|cp|rm|chmod|chown|ln|dd|install|truncate|patch|rsync)\\b|\\bgit\\s+(?:checkout|apply|restore|stash)\\b'
const WRITES_STRICT = new RegExp(SHELL_WRITES)
/** The same, plus an interpreter, which can write whatever its script says. */
const WRITES = new RegExp(`${SHELL_WRITES}|\\b(?:python3?|node|ruby)\\b|\\bbun\\b(?!\\s+test\\b)`)
const quiet = (cmd: string) => cmd.replace(/\d*>&\d+|\d*>>?\s*\/dev\/null/g, ' ')

/** A command line split into simple commands, each a list of words with quotes removed. Quotes keep `;` and `|` inside a word. */
function simpleCommands(cmd: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let q: '' | "'" | '"' = ''
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCmd = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string
    if (q === "'") {
      if (c === "'") q = ''
      else word += c
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[++i]
      has = true
      continue
    }
    if (q === '"') {
      if (c === '"') q = ''
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (/[;&|\n()`]/.test(c)) endCmd()
    else if (/\s/.test(c)) endWord()
    else {
      word += c
      has = true
    }
  }
  endCmd()
  return out
}

/** The name of the terminal-only command this one runs, or undefined. Looks only where a command is, not at any word. */
function gatedIn(cmd: string, depth = 0): string | undefined {
  if (depth > 4) return undefined
  const inner = [...cmd.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '')
  for (const sub of inner) {
    const hit = gatedIn(sub, depth + 1)
    if (hit) return hit
  }
  for (const words of simpleCommands(cmd)) {
    let i = 0
    for (;;) {
      const w = words[i]
      if (w === undefined) break
      const base = basename(w)
      if (/^[A-Za-z_]\w*=/.test(w)) i++
      else if (WRAPPERS.has(base)) {
        i++
        while (words[i] !== undefined && /^(-|\d+$|\/dev\/|[A-Za-z_]\w*=)/.test(words[i] as string)) i++
      } else break
    }
    const head = words[i]
    if (head === undefined) continue
    const base = basename(head)
    const firstWord = (rest: string[]) => {
      let k = 0
      while (rest[k]?.startsWith('-')) k++
      return rest.slice(k)
    }
    if (base === 'talos-app' || base === 'talos') {
      const hit = terminalOnly(firstWord(words.slice(i + 1)))
      if (hit) return hit
    } else if (RUNNERS.has(base)) {
      const at = words.findIndex((w, k) => k > i && /^cli(?:-main)?(?:\.[tj]s)?$/.test(basename(w)))
      if (at > 0) {
        const hit = terminalOnly(firstWord(words.slice(at + 1)))
        if (hit) return hit
      }
    } else if (SHELLS.has(base)) {
      const c = words.findIndex((w, k) => k > i && /^-\w*c\w*$/.test(w))
      if (c > 0 && words[c + 1] !== undefined) {
        const hit = gatedIn(words[c + 1] as string, depth + 1)
        if (hit) return hit
      }
    } else if (base === 'eval') {
      const hit = gatedIn(words.slice(i + 1).join(' '), depth + 1)
      if (hit) return hit
    }
  }
  return undefined
}

/** Both spellings of a path under a symlinked root (`/tmp` and `/private/tmp`), lower-cased: macOS compares names without case. */
function spellings(p: string): string[] {
  const l = p.toLowerCase()
  return l.startsWith('/private/') ? [l, l.slice('/private'.length)] : [l]
}

/** `~`, `$HOME` and `${HOME}` written out, so the rest of the checks see one spelling. */
function expandHome(cmd: string, userHome: string): string {
  return cmd
    .replace(/(^|[\s='":;|&(<>])~(?=$|[/\s'":;|&)<>])/g, `$1${userHome}`)
    .replace(/\$\{HOME\}|\$HOME\b/g, userHome)
}

/** Everything a command line says about paths, in one lower-cased string: the text itself and each absolute word resolved. */
function haystack(cmd: string, userHome: string): { hay: string; tokens: string[] } {
  const text = expandHome(cmd, userHome)
  const tokens = text.split(/[\s'"`;|&<>()=,{}]+/).filter((t) => t.startsWith('/') && !/[*?[]/.test(t))
  const resolved = tokens.map((t) => real(t))
  return { hay: [text, ...resolved].join('\n').toLowerCase(), tokens: resolved.map((t) => t.toLowerCase()) }
}

/** The part of a glob word before its first wildcard; undefined if the word has none. */
function globStem(word: string): string | undefined {
  const at = word.search(/[*?[{]/)
  return at < 0 ? undefined : word.slice(0, at)
}

function bashDecision(cmd: string, cfg: GuardConfig): GuardDeny | undefined {
  const gated = gatedIn(cmd)
  if (gated || (FAKE_TTY.test(cmd) && LOOSE_GATED.test(cmd)))
    return {
      deny: FAKE_TTY.test(cmd)
        ? 'Talos guard: this fakes a terminal to run a human-only talos-app command. Only the owner runs those, in Terminal.'
        : `Talos guard: \`talos-app ${gated}\` is human-only. Ask the owner to run it in Terminal.`,
    }
  if (/\bclaude\s+plugins?\b/.test(cmd))
    return { deny: 'Talos guard: `claude plugin` changes what runs inside Claude Code; the owner does that.' }
  if (/action-rules\.py\s+approve/.test(cmd))
    return { deny: "Talos guard: approving an action rule is the owner's call." }

  const { hay, tokens } = haystack(cmd, cfg.userHome)
  const names = (dir: string, list: string[]) => list.flatMap((n) => spellings(join(dir, n)))
  const mentions = (paths: string[]) => paths.some((p) => hay.includes(p))

  if (BARE_STEMS.some((s) => hay.includes(s)) || mentions(names(cfg.home, HOME_NEVER)))
    return {
      deny: 'Talos guard: the guard rules, the tripwire record, enroll-pending and agent-request.json belong to the app and the owner; no command may touch them.',
    }
  // a wildcard that could expand to one of them: match on the stem
  const words = expandHome(cmd, cfg.userHome).split(/[\s'"`;|&<>()=,]+/)
  const homeDirs = spellings(cfg.home).map((h) => `${h}/`)
  for (const w of words) {
    const stem = globStem(w)
    if (stem === undefined) continue
    const l = stem.toLowerCase()
    const dir = homeDirs.find((h) => l.startsWith(h))
    if (dir) {
      const rest = l.slice(dir.length)
      const reaches = rest === '' ? WRITES_STRICT.test(quiet(cmd)) : HOME_NEVER.some((n) => n.startsWith(rest))
      if (reaches)
        return {
          deny: 'Talos guard: that wildcard can reach a file the guards protect (guards, tripwire, enroll-pending, agent-request).',
        }
    } else if (
      !l.includes('/') &&
      l.length >= 2 &&
      HOME_NEVER.some((n) => n.startsWith(l)) &&
      WRITES_STRICT.test(quiet(cmd))
    ) {
      return {
        deny: 'Talos guard: that wildcard can reach a file the guards protect (guards, tripwire, enroll-pending, agent-request).',
      }
    }
  }
  const writes = WRITES.test(quiet(cmd))
  if (writes && mentions(names(cfg.home, HOME_READ_ONLY)))
    return {
      deny: 'Talos guard: devices.json and config.json decide who is trusted, and last-good and config-history hold the saved setups a restore puts back; the app writes them, not a command.',
    }
  if (WRITES_STRICT.test(quiet(cmd)) && tokens.some((t) => spellings(cfg.home).includes(t.replace(/\/$/, ''))))
    return { deny: 'Talos guard: this writes inside the Talos home, which holds the trust files.' }

  const plugins = [join(cfg.claudeHome, 'plugins'), join(cfg.claudeHome, 'dev-mods')]
  if (/\.claude\/(?:plugins|dev-mods)/.test(hay) || mentions(plugins.flatMap(spellings)))
    return { deny: "Talos guard: the plugin and mod folders are the owner's to change." }
  if (writes) {
    const hit = [cfg.checkout, ...cfg.protectedPaths].find((p) => mentions(spellings(p)))
    if (hit) return { deny: `Talos guard: this looks like a write under ${hit}, which is on the never-change list.` }
  }
  return undefined
}

export function guardDecision(call: GuardCall, cfg: GuardConfig): GuardDeny | undefined {
  const input = (call.tool_input ?? {}) as Record<string, unknown>
  if ((WRITE_TOOLS as readonly string[]).includes(call.tool_name)) {
    const file = input.file_path ?? input.notebook_path
    if (typeof file !== 'string' || !file)
      return { deny: 'Talos guard: cannot tell which file this writes, so it is blocked.' }
    const abs = real(file.startsWith('~') ? join(cfg.userHome, file.slice(1)) : file).toLowerCase()
    const hit = cfg.writeDenied.find((t) => spellings(t).some((s) => under(abs, s)))
    return hit
      ? {
          deny: `Talos guard: ${hit} is on the never-change list (protected paths, guard and trust files, plugins, mods). Ask the owner.`,
        }
      : undefined
  }
  if (call.tool_name !== 'Bash') return undefined
  const cmd = typeof input.command === 'string' ? input.command : undefined
  if (cmd === undefined) return { deny: 'Talos guard: cannot read this command, so it is blocked.' }
  return bashDecision(cmd, cfg)
}
