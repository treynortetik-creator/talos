// What the guard hook and the permission deny rules protect, and the one function that decides a tool call. Both outputs
// of `talos-app install-guards` come from the same `GuardConfig`, so the hook and the rules never disagree.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { WORKER_FILES } from '@talos-app/protocol'
import { realFileSync, walkLinks } from '../real-file.ts'
import { appOnly, COMMANDS, kitVendorDir, terminalOnly, terminalOnlyNames } from '../talos.ts'

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

/** `cwd` is the hook input's working folder (Claude Code sends it to every hook); absent, relative names are not taken as the home's. */
export type GuardCall = { tool_name: string; tool_input?: unknown; cwd?: string }
export type GuardDeny = { deny: string }

/** The tools that write a file. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export function buildGuardConfig(a: {
  home: string
  checkout: string
  claudeHome: string
  userHome?: string
  /** The kit's vendor folder. Absent: from the environment, as at install. The refresh passes the installed one: it reads no environment. */
  kitDir?: string
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
  // The kit's releases and `current`: a release the agent could write is a release that would run as the agent's own guards.
  // `talos update` is the only way in, and it checks a signature first.
  protectedPaths.push(real(a.kitDir ?? kitVendorDir(process.env, a.userHome ?? homedir())))
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
      ...KEY_FILES.map((f) => join(real(a.home), f)),
      join(real(a.home), 'guards'),
      join(real(a.home), 'tripwire.json'),
      join(real(a.home), 'tripwire.writing'),
      join(real(a.home), 'devices.json'),
      // the screen helper's allowed-apps list: Talos.app is its only writer (it is sealed too; this keeps a session from trying)
      join(real(a.home), 'screen'),
      join(real(a.home), 'config.json'),
      // the folders the owner chose for threads (supervisor/owner-folders.ts): only the bridge writes it, after a signed config.patch;
      // a session that could write it could have a folder it picked trusted with no card
      join(real(a.home), 'owner-folders.json'),
      // phone recovery: the request file the Mac app acts on, and the saved setups a restore reads
      join(real(a.home), 'agent-request.json'),
      // permission_mode: the request the Mac app acts on to change Main's permission mode (only the bridge writes it)
      join(real(a.home), 'permission-mode-request.json'),
      // restart_main: the Mac app's own answer to "would Main come back?" (only the app writes it; the bridge reads it)
      join(real(a.home), 'main-restart-check.json'),
      join(real(a.home), 'last-good'),
      join(real(a.home), 'config-history'),
      // relay updates: which service is redeployed, the auto-update switch, the attempt being followed, and the two files the
      // bridge and the Mac app pass between them (docs/deploy-railway.md); only the bridge, the app and the owner's command write them
      join(real(a.home), 'relay-connect.json'),
      join(real(a.home), 'relay-auto.json'),
      join(real(a.home), 'relay-redeploy-request.json'),
      join(real(a.home), 'relay-redeploy-result.json'),
      // the Linux supervisor's own files (a session runs as the same user, so these rules are the only thing in its way): what it
      // is told to do (supervisor-control: start or stop Main, past every restart check), the owner's Stop, the launch, the
      // launch scripts, and the owner's restart proofs already used
      ...SUPERVISOR_NEVER.map((f) => join(real(a.home), f)),
      ...SUPERVISOR_READ_ONLY.map((f) => join(real(a.home), f)),
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
    // basename, not a slice past dirname: under `/` that slice ate the name's first letter (`/srv-x` became `/rv-x`)
    tail.unshift(basename(cur))
    cur = dirname(cur)
  }
  // the deepest part that exists may be a file (an Edit's file_path): walked, never named by another hard link (real-file.ts).
  // Where its spelling cannot be read (a folder on the way with no read bit), still where its links lead: never the link's text.
  try {
    cur = realFileSync(cur)
  } catch {
    try {
      cur = walkLinks(cur)
    } catch {}
  }
  return join(cur, ...tail)
}

const under = (p: string, target: string) => p === target || p.startsWith(target + sep)

/** `Edit(//abs/path)` is Claude Code's spelling of an absolute path in a permission rule. */
export function denyRules(cfg: GuardConfig): string[] {
  const edit = cfg.writeDenied.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])
  const keys = KEY_FILES.map((f) => `Read(/${join(cfg.home, f)})`)
  const gated = [
    ...terminalOnlyNames('talos-app').map((n) => `Bash(talos-app ${n}:*)`),
    ...terminalOnlyNames('talos').map((n) => `Bash(talos ${n}:*)`),
    // app-only (talos.ts appOnly): the Mac app runs it, never a session
    'Bash(talos-app guards:*)',
  ]
  // needs-you prompts: the files the Mac and the bridge pass an answer through, in every thread's folder
  const dialog = DIALOG_FILE_NAMES.flatMap((n) => [`Edit(/${cfg.home}/workers/**/${n})`, `Bash(*${n}*)`])
  return [
    ...edit,
    ...keys,
    ...dialog,
    ...gated,
    'Bash(claude plugin:*)',
    'Bash(claude plugins:*)',
    'Bash(talos-update:*)',
    'Bash(*talos-update.py*)',
    'Bash(*enroll-pending*)',
    'Bash(*agent-request.json*)',
    'Bash(*permission-mode-request.json*)',
    ...SUPERVISOR_NEVER.map((f) => `Bash(*${f}*)`),
    'Bash(*main-restart-check.json*)',
    'Bash(*relay-redeploy-request.json*)',
    'Bash(*relay-redeploy-result.json*)',
    'Bash(*.claude/plugins*)',
    'Bash(*.claude/dev-mods*)',
  ]
}

/**
 * The Linux supervisor's files a session may not even name (cli.ts SUPERVISOR_FILES, restart-proof.ts): the control file it
 * acts on, the owner's Stop, and the owner's restart proofs already used with their mark.
 */
const SUPERVISOR_NEVER = [
  'supervisor-control',
  'supervisor-stopped',
  'restart-proofs-used.json',
  'restart-proof-mark.json',
  // the restart actor's own state across a restart (main-request.ts)
  'restart-actor.json',
]
/** The supervisor's files a session may read but never write: the launch, and the launch scripts. */
const SUPERVISOR_READ_ONLY = ['supervisor.json', 'launch']

/**
 * The deny rules for the supervisor's files, from THIS code: added at every launch to the guard settings Main gets (main-launch.ts),
 * so a machine whose guards were installed before these files existed is covered without install-guards run again (Fable R1-6).
 */
export function supervisorDenyRules(talosHome: string): string[] {
  const home = real(talosHome)
  return [
    ...[...SUPERVISOR_NEVER, ...SUPERVISOR_READ_ONLY].flatMap((f) => [
      `Edit(/${join(home, f)})`,
      `Edit(/${join(home, f)}/**)`,
    ]),
    ...SUPERVISOR_NEVER.map((f) => `Bash(*${f}*)`),
  ]
}

/** Files and folders inside the Talos home that no command may name at all. */
/** The bridge's signing keys: a session that read one could sign as the bridge. */
const KEY_FILES = ['bridge.key', 'bridge.key.next', 'bridge.key.prev']
const HOME_NEVER = [
  // the file tools and the cat path refuse them; a script that opens one is the light lead profile's open gap (docs/OPTION-C.md)
  ...KEY_FILES,
  'enroll-pending',
  'guards',
  'guards.json',
  'tripwire.json',
  'tripwire.writing',
  'agent-request.json',
  'permission-mode-request.json',
  'main-restart-check.json',
  // the relay update request and the Mac app's answer: the bridge and the app are the only writers (relay/files.ts)
  'relay-redeploy-request.json',
  'relay-redeploy-result.json',
  ...SUPERVISOR_NEVER,
]
/**
 * The files under `workers/<thread>/` that pass between the supervisor and the bridge, so no tool touches them: the needs-you
 * files (dialog-files.ts; a forged one would press a key in a session), and the wake bookkeeping (wake-decision.ts; the reader's
 * own count of the restarts it carried out, and the bridge's record of the ones it wrote: a forged one would lift the cap).
 */
const DIALOG_FILE_NAMES: string[] = [
  WORKER_FILES.dialogCard,
  WORKER_FILES.dialogAnswer,
  WORKER_FILES.mainDialogAnswer,
  WORKER_FILES.dialogResult,
  WORKER_FILES.dialogProofsUsed,
  WORKER_FILES.mainDialogProofsUsed,
  WORKER_FILES.wakeState,
  WORKER_FILES.wakeWritten,
]
/** The needs-you file `abs` (lower-cased, resolved) names inside a worker's folder, or undefined. */
function dialogFileAt(abs: string, home: string): string | undefined {
  const name = DIALOG_FILE_NAMES.find((n) => basename(abs) === n)
  const inWorkers = spellings(join(home, 'workers')).some((w) => abs.startsWith(`${w}${sep}`))
  return name && inWorkers ? name : undefined
}
/** Files inside the Talos home that a command may read but not write. */
const HOME_READ_ONLY = [
  'devices.json',
  'config.json',
  'owner-folders.json',
  // which relay service is redeployed, the auto-update switch and the one attempt being followed (no secret in either)
  'relay-connect.json',
  'relay-auto.json',
  'last-good',
  'config-history',
  'screen',
  ...SUPERVISOR_READ_ONLY,
]
/** Spellings of those names that mean the file wherever the shell is standing (`cd <home> && rm guards.json`). */
const BARE_STEMS = [
  'guards.json',
  'tripwire.json',
  'tripwire.writing',
  'enroll-pend',
  'agent-request.json',
  'permission-mode-request.json',
  'main-restart-check.json',
  'relay-redeploy-request.json',
  'relay-redeploy-result.json',
  ...SUPERVISOR_NEVER,
  ...DIALOG_FILE_NAMES,
]

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
// (and the other ways to hand a command a terminal: tmux, screen, systemd-run --pty, ssh -t, a pty module however imported;
// SECURITY.md names the routes left, a renamed link among them)
const FAKE_TTY =
  /\b(?:script|unbuffer|expect|faketty|socat|pexpect|ptyprocess|tmux|screen|systemd-run)\b|\bpty\b|\bssh\b[^|;&]*\s-\w*t/
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
        while (words[i] !== undefined && /^(-|\d+$|\/dev\/|[A-Za-z_]\w*=)/.test(words[i] as string)) {
          // an option that takes the next word as its value (`env -u NAME`, `sudo -u user`, `env -C dir`): both are skipped
          if (/^(?:-u|--unset|-C|--chdir|-g|--user|--group)$/.test(words[i] as string)) i++
          i++
        }
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
    // the kit updater itself, run by name or through an interpreter: the same command as `talos update`, whatever it is called
    if (
      base === 'talos-update' ||
      (/^(?:python[\d.]*|bash|sh|zsh)$/.test(base) &&
        words.slice(i + 1).some((x) => /^talos-update(?:\.py)?$/.test(basename(x))))
    )
      return 'update'
    if (base === 'talos-app' || base === 'talos') {
      const hit =
        terminalOnly(firstWord(words.slice(i + 1)), base) ??
        (base === 'talos-app' ? appOnly(firstWord(words.slice(i + 1))) : undefined)
      if (hit) return hit
    } else if (RUNNERS.has(base)) {
      const at = words.findIndex((w, k) => k > i && /^(?:cli(?:-main)?|talos)(?:\.[tj]s)?$/.test(basename(w)))
      if (at > 0) {
        const prog = /^talos/.test(basename(words[at] as string)) ? 'talos' : 'talos-app'
        const rest = firstWord(words.slice(at + 1))
        const hit = terminalOnly(rest, prog) ?? (prog === 'talos-app' ? appOnly(rest) : undefined)
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

/**
 * `~`, `$HOME` and `${HOME}` written out, and the Talos home's own `$TALOS_APP_HOME` / `${TALOS_APP_HOME}`, so the rest of the
 * checks see one spelling.
 */
function expandHome(cmd: string, userHome: string, home = ''): string {
  const out = cmd
    .replace(/(^|[\s='":;|&(<>])~(?=$|[/\s'":;|&)<>])/g, `$1${userHome}`)
    .replace(/\$\{HOME\}|\$HOME\b/g, userHome)
  return home ? out.replace(/\$\{TALOS_APP_HOME\}|\$TALOS_APP_HOME\b/g, home) : out
}

/**
 * The command as the shell would see its words: quotes and backslashes taken away (`supervisor-""control`, `supervisor\-control`
 * and `super"visor-con"trol` are all `supervisor-control`), one simple command per line.
 */
const unquoted = (cmd: string): string =>
  simpleCommands(cmd)
    .map((w) => w.join(' '))
    .join('\n')

/** Everything a command line says about paths, in one lower-cased string: the text itself and each absolute word resolved. */
function haystack(cmd: string, userHome: string, home = ''): { hay: string; tokens: string[] } {
  const expanded = expandHome(cmd, userHome, home)
  // the text as written, and as its words read once quotes and backslashes are gone
  const text = `${expanded}\n${unquoted(expanded)}`
  const tokens = text.split(/[\s'"`;|&<>()=,{}]+/).filter((t) => t.startsWith('/') && !/[*?[]/.test(t))
  const resolved = tokens.map((t) => real(t))
  return { hay: [text, ...resolved].join('\n').toLowerCase(), tokens: resolved.map((t) => t.toLowerCase()) }
}

/** The part of a glob word before its first wildcard; undefined if the word has none. */
function globStem(word: string): string | undefined {
  const at = word.search(/[*?[{]/)
  return at < 0 ? undefined : word.slice(0, at)
}

/**
 * A file that already exists under another name by a hard link to one of `protectedFiles` (same device and inode, more than one
 * link): a write through that name writes the protected file. Seen only for a link made before the command (one the same command
 * makes is past what a guard reads).
 */
function hardLinkTo(path: string, protectedFiles: readonly string[]): string | undefined {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.nlink < 2) return undefined
    return protectedFiles.find((f) => {
      try {
        const p = lstatSync(f)
        return p.ino === st.ino && p.dev === st.dev
      } catch {
        return false
      }
    })
  } catch {
    return undefined
  }
}

/** Verbs whose every non-option word is written, moved or removed. */
const TARGET_ALL = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'touch',
  'tee',
  'mv',
  'patch',
])
/** Verbs that write their last word (cp a b, ln -s a b, install a b, rsync a b). */
const TARGET_LAST = new Set(['cp', 'ln', 'install', 'rsync'])
const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|bun|deno|php|lua|osascript|sh|bash|zsh|dash|ksh)$/

/**
 * Where a command line writes, as far as its words say: redirect targets, each writing verb's targets, the files of an in-place
 * `sed -i`/`perl -i`, `dd of=`, and every word of an interpreter (its script can write anything it names). Resolved and
 * lower-cased. Paths only: a pattern guard cannot follow names built at run time (see bashDecision).
 */
function writeTargets(cmd: string, cfg: GuardConfig): string[] {
  const text = expandHome(cmd, cfg.userHome, cfg.home)
  const out: string[] = []
  for (const m of quiet(text).matchAll(/>>?\|?\s*([^\s;|&<>()]+)/g)) out.push(m[1] as string)
  for (const words of simpleCommands(text)) {
    let i = 0
    while (
      words[i] !== undefined &&
      (WRAPPERS.has(basename(words[i] as string)) || /^[A-Za-z_]\w*=/.test(words[i] as string))
    )
      i++
    const head = basename(words[i] ?? '')
    const args = words.slice(i + 1).filter((w) => !w.startsWith('-'))
    if (TARGET_ALL.has(head)) out.push(...args)
    else if (TARGET_LAST.has(head) && args.length > 0) out.push(args[args.length - 1] as string)
    else if ((head === 'sed' || head === 'perl') && words.slice(i + 1).some((w) => /^-\S*i/.test(w))) out.push(...args)
    else if (head === 'dd') out.push(...words.filter((w) => w.startsWith('of=')).map((w) => w.slice(3)))
    else if (INTERPRETERS.test(head)) out.push(...words.slice(i + 1))
  }
  // resolved, in their own case (a file is looked at by its real name); callers compare lower-cased
  return out.map((t) => (t.startsWith('/') ? real(t) : t))
}

const MAYBE = Symbol('maybe the home')

/** One simple command and the folder it runs in: a path, MAYBE (see below), or not known; `byCd` when a cd in the command set it. */
type Ran = { text: string; at: string | typeof MAYBE | undefined; byCd: boolean }

/**
 * Each simple command with the folder it runs in. The folder starts at the call's `cwd` (Claude Code gives it to every hook) and
 * follows each `cd`: an absolute target (`~`, `$HOME` and `$TALOS_APP_HOME` expanded first) or `cd` alone (the user home) is
 * resolved, a relative one against the folder before it. A `cd` that cannot be resolved (a variable, a subshell, `cd -`, or `..`
 * from a folder not known) leaves the folder not known, which is NOT the home: those are ordinary in every build script (Pantheon
 * 2026-11-13). From a folder not known, a relative `cd` through `.config` or the home's own folder name is MAYBE the home.
 */
function whereEachRuns(cmd: string, cfg: GuardConfig, cwd: string | undefined): Ran[] {
  const homeName = basename(cfg.home).toLowerCase()
  const out: Ran[] = []
  let at: Ran['at'] = cwd?.startsWith('/') ? real(cwd) : undefined
  let byCd = false
  for (const words of simpleCommands(expandHome(cmd, cfg.userHome, cfg.home))) {
    const head = words[0]
    if (head !== 'cd' && head !== 'pushd') {
      out.push({ text: words.join(' '), at, byCd })
      continue
    }
    byCd = true
    const target = words.slice(1).find((w) => !w.startsWith('-') || w === '-')
    if (target === undefined) at = head === 'cd' ? cfg.userHome : undefined
    else if (target === '-' || /[$`]/.test(target)) at = undefined
    else if (target.startsWith('/')) at = real(target)
    else if (at !== undefined && at !== MAYBE) at = real(resolve(at, target))
    else {
      const parts = target.toLowerCase().split('/')
      at = parts.includes('.config') || parts.includes(homeName) ? MAYBE : undefined
    }
  }
  return out
}

/**
 * Whether relative names in a command that ran there may be the home's: MAYBE, the home or a folder inside it, or a folder above it
 * that a cd in the command chose (`cd ~/.config && find . -delete`). A session that merely starts in the user home, `/` or
 * `~/.config` is not in the home (Fable R1-1 on fce1adcb).
 */
function ranInHome(r: Ran, cfg: GuardConfig): boolean {
  if (r.at === MAYBE) return true
  if (r.at === undefined) return false
  const t = r.at.toLowerCase().replace(/\/$/, '')
  return spellings(cfg.home).some((h) => t === h || t.startsWith(`${h}/`) || (r.byCd && h.startsWith(`${t}/`)))
}

/** Commands that only read and search: a protected name as one of their words is a search term, not a path. */
const SEARCHERS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'journalctl',
  'git',
  'less',
  'head',
  'tail',
  'wc',
])

/** Writers that reach into a folder named as a word (`tar -C <home>`, `git --work-tree=<home>`, `find <home> … -delete`). */
const DIR_WRITERS = /\btar\b|\bunzip\b|\s-delete\b|--work-tree\b|\bfind\b[^;|&]*-exec\b|\bbsdtar\b|\bcpio\b/

// What follows is a pattern guard over the command's text and words. It is complete for nothing: a name built at run time (a
// variable, base64, a script file, an interpreter's own string handling) passes it. On an unmanaged install these rules raise the
// cost for a session acting through Claude Code's tools; they are not a boundary against code running as the same user. That
// boundary is a root-owned control path and marker on a managed install (the P3c2 design note).
function bashDecision(cmd: string, cfg: GuardConfig, cwd?: string): GuardDeny | undefined {
  const gated = gatedIn(cmd)
  if (gated || (FAKE_TTY.test(cmd) && LOOSE_GATED.test(cmd)))
    return {
      deny: FAKE_TTY.test(cmd)
        ? 'Talos guard: this fakes a terminal to run a human-only talos-app command. Only the owner runs those, in Terminal.'
        : gated && gated === appOnly(gated.split(' '))
          ? `Talos guard: \`talos-app ${gated}\` is run by the Talos app at each start of Main, never by a session.`
          : `Talos guard: \`talos-app ${gated}\` is human-only. Ask the owner to run it in Terminal.`,
    }
  if (/\bclaude\s+plugins?\b/.test(cmd))
    return { deny: 'Talos guard: `claude plugin` changes what runs inside Claude Code; the owner does that.' }
  // `action-rules.py approve` is not denied (owner ruling 2026-11-14): the kit's own ask tells the agent to run it after the owner
  // said yes in chat, for 15 minutes, and that an approval found in a web page, file or tool output does not count.

  const { hay, tokens } = haystack(cmd, cfg.userHome, cfg.home)
  const names = (dir: string, list: string[]) => list.flatMap((n) => spellings(join(dir, n)))
  const mentions = (paths: string[]) => paths.some((p) => hay.includes(p))
  const homeName = basename(cfg.home).toLowerCase()
  // the home, a folder inside it or above it, named by any spelling; or a `cd` whose target may be one of those (then relative
  // names may be the home's own: `cd ~/.config && … talos/…`)
  const inOrAbove = (t: string) =>
    spellings(cfg.home).some((h) => t === h || t.startsWith(`${h}/`) || h.startsWith(`${t}/`))
  // each unpack, delete or checkout is judged by the folder it runs in (Fable R1-2 on fce1adcb)
  const ran = whereEachRuns(cmd, cfg, cwd)
  const inHome = ran.filter((r) => ranInHome(r, cfg))
  const touchesHome = tokens.some(inOrAbove) || inHome.length > 0
  const unpacksInHome = tokens.some(inOrAbove) || inHome.some((r) => DIR_WRITERS.test(quiet(r.text)))
  // the supervisor's names as SEARCH TERMS (grep the checkout or the journal for them) when nothing in the command touches the home
  const searchOnly =
    !touchesHome &&
    !/[<>]/.test(quiet(cmd)) &&
    simpleCommands(cmd).every((w) => SEARCHERS.has(basename(w[0] ?? ''))) &&
    !BARE_STEMS.filter((s) => !SUPERVISOR_NEVER.includes(s)).some((s) => hay.includes(s))

  if ((BARE_STEMS.some((s) => hay.includes(s)) && !searchOnly) || mentions(names(cfg.home, HOME_NEVER)))
    return {
      deny: "Talos guard: the guard rules, the tripwire record, enroll-pending, agent-request.json, permission-mode-request.json, main-restart-check.json, the supervisor's control file, the owner's Stop (supervisor-stopped), the restart proofs and the bridge's signing keys (bridge.key and its .next and .prev) belong to the app and the owner; no command may touch them. The same goes for the needs-you files (dialog-answer.json and its siblings) and the wake bookkeeping (wake-state.json, wake-written.json).",
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
          deny: 'Talos guard: that wildcard can reach a file the guards protect (guards, tripwire, enroll-pending, agent-request, permission-mode-request, main-restart-check).',
        }
    } else if (
      !l.includes('/') &&
      l.length >= 2 &&
      HOME_NEVER.some((n) => n.startsWith(l)) &&
      WRITES_STRICT.test(quiet(cmd))
    ) {
      return {
        deny: 'Talos guard: that wildcard can reach a file the guards protect (guards, tripwire, enroll-pending, agent-request, permission-mode-request, main-restart-check).',
      }
    }
  }
  // a wildcard that could expand to a needs-you file inside a worker's folder
  for (const w of words) {
    const stem = globStem(w)?.toLowerCase()
    const last = stem?.slice(stem.lastIndexOf('/') + 1) ?? ''
    if (last.length >= 6 && DIALOG_FILE_NAMES.some((n) => n.startsWith(last)))
      return { deny: 'Talos guard: that wildcard can reach a needs-you file (dialog-answer.json and its siblings).' }
  }
  const writes = WRITES.test(quiet(cmd))
  // the launch and its scripts: read freely (a pipe into json.tool, a copy out to /tmp), never a target of a write
  const rawTargets = writeTargets(cmd, cfg)
  const targets = rawTargets.map((t) => t.toLowerCase())
  const launchFiles = SUPERVISOR_READ_ONLY.flatMap((n) => spellings(join(cfg.home, n)))
  const hitsLaunch =
    targets.some(
      (t) =>
        // (an interpreter's words are whole strings: a path anywhere in one counts)
        launchFiles.some((f) => t === f || t.includes(f)) ||
        // a bare name where the folder may be the home but is not known (Fable R2-3)
        (ran.some((r) => r.at === MAYBE) &&
          SUPERVISOR_READ_ONLY.some(
            (n) => t === n || t.startsWith(`${n}/`) || t.endsWith(`/${n}`) || t.includes(`${homeName}/${n}`),
          )),
    ) ||
    // a bare or relative name, resolved against the folder its command runs in: only the launch files themselves count, not the same
    // name in another folder inside or above the home (Fable R1-1 on fce1adcb)
    ran.some(
      (r) =>
        typeof r.at === 'string' &&
        writeTargets(r.text, cfg)
          .filter((t) => !t.startsWith('/'))
          .some((t) => {
            const p = real(resolve(r.at as string, t)).toLowerCase()
            return launchFiles.some((f) => p === f || p.startsWith(`${f}/`))
          }),
    )
  const linked = rawTargets.find(
    (t) =>
      t.startsWith('/') &&
      hardLinkTo(
        t,
        [...SUPERVISOR_NEVER, ...SUPERVISOR_READ_ONLY, ...HOME_NEVER].map((f) => join(cfg.home, f)),
      ),
  )
  if (linked) return { deny: `Talos guard: ${linked} is a hard link to a file the guards protect.` }
  if (hitsLaunch)
    return {
      deny: 'Talos guard: supervisor.json and launch/ are how Main is started; the owner changes them, not a command.',
    }
  // a folder at or above the home moved or removed whole (mv ~/.config elsewhere takes the home with it)
  for (const words of simpleCommands(expandHome(cmd, cfg.userHome, cfg.home))) {
    const head = basename(words[0] ?? '')
    if (head !== 'mv' && head !== 'rm' && head !== 'rmdir' && head !== 'rsync') continue
    const args = words.slice(1).filter((w) => !w.startsWith('-'))
    const moved = head === 'mv' ? args.slice(0, -1) : args
    if (
      moved.some((a) => {
        const r = real(a).toLowerCase().replace(/\/$/, '')
        return r !== '' && r !== '/' && spellings(cfg.home).some((h) => h === r || h.startsWith(`${r}/`))
      })
    )
      return { deny: 'Talos guard: this moves or removes the Talos home (or a folder holding it).' }
  }
  if (unpacksInHome && DIR_WRITERS.test(quiet(cmd)))
    return { deny: 'Talos guard: this unpacks, deletes or checks out files inside the Talos home.' }
  const READ_ONLY_STRICT = HOME_READ_ONLY.filter((n) => !SUPERVISOR_READ_ONLY.includes(n))
  if (writes && mentions(names(cfg.home, READ_ONLY_STRICT)))
    return {
      deny: 'Talos guard: devices.json and config.json decide who is trusted, last-good and config-history hold the saved setups a restore puts back, screen/ holds the apps the owner let agents control, and supervisor.json and launch/ are how Main is started; the app writes them, not a command.',
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
    const dialog = dialogFileAt(abs, cfg.home)
    if (dialog) return { deny: `Talos guard: ${dialog} is passed between the Mac and the bridge; only they write it.` }
    // the installed list, and the supervisor's files from THIS code: a machine updated without running install-guards again is
    // still covered for them (its guards.json was written before they existed; Fable R1-6)
    const live = [...SUPERVISOR_NEVER, ...SUPERVISOR_READ_ONLY].map((f) => join(cfg.home, f))
    const hit =
      [...cfg.writeDenied, ...live].find((t) => spellings(t).some((s) => under(abs, s))) ??
      hardLinkTo(file.startsWith('~') ? join(cfg.userHome, file.slice(1)) : file, [...cfg.writeDenied, ...live])
    return hit
      ? {
          deny: `Talos guard: ${hit} is on the never-change list (protected paths, guard and trust files, plugins, mods). Ask the owner.`,
        }
      : undefined
  }
  if (call.tool_name === 'Read' || call.tool_name === 'Grep') {
    const file = input.file_path ?? input.path
    if (typeof file !== 'string' || !file) return undefined
    const abs = real(file.startsWith('~') ? join(cfg.userHome, file.slice(1)) : file).toLowerCase()
    const key = KEY_FILES.find((f) => spellings(join(cfg.home, f)).some((s) => abs === s))
    return key ? { deny: `Talos guard: ${key} is the bridge's signing key; no session reads it.` } : undefined
  }
  if (call.tool_name !== 'Bash') return undefined
  const cmd = typeof input.command === 'string' ? input.command : undefined
  if (cmd === undefined) return { deny: 'Talos guard: cannot read this command, so it is blocked.' }
  return bashDecision(cmd, cfg, typeof call.cwd === 'string' ? call.cwd : undefined)
}
