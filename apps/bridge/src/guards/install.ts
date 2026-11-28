// `talos-app install-guards [--remove]`: writes the PreToolUse guard hook and the permission deny rules to
// <home>/guards/, which is outside the agent folder. Nothing runs them until the agent is started with
// `claude --settings <home>/guards/settings.json` (`talos-app start` adds that by itself once the file exists).
// Never run by default; idempotent; `--remove` deletes exactly what it wrote.
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { claudeConfigDir } from '../claude-dir.ts'
import type { BridgeEnv } from '../config.ts'
import { ensureDir } from '../fsutil.ts'
import { BUN_CACHE_OFF } from '../mcp-config.ts'
import { say } from '../owner-words.ts'
import { realFileSync } from '../real-file.ts'
import { mainLaunchArgs } from './main-launch.ts'
import { buildGuardConfig, denyRules, type GuardConfig, real, WRITE_TOOLS } from './rules.ts'

type Out = { out(l: string): void; err(l: string): void }
/** The checkout this code runs from: what the hook command names, and what the rules protect as "the running checkout". */
export const CHECKOUT = resolve(import.meta.dir, '..', '..', '..', '..')

export const guardsDir = (home: string) => join(home, 'guards')
export const guardsSettings = (home: string) => join(guardsDir(home), 'settings.json')
export const GUARD_HOOK_GONE_REASON =
  "This session's guard hook can't start (its Bun moved). Talos is restarting the session; nothing is lost."
/** The rules file of the installs before content addressing: still read, and kept while a running session's hook names it. */
export const guardsRules = (home: string) => join(guardsDir(home), 'guards.json')
/** The rules file for rules with this hash: written once, never over (a running session's hook may name it). */
export const rulesFileFor = (home: string, sha: string) => join(guardsDir(home), `guards-${sha}.json`)
/** Every name a rules file has had, for the collection of the ones nothing names any more. */
export const RULES_FILE_NAME = /^guards(?:-[0-9a-f]{64})?\.json$/

/** The bun running this code, by its real path (a Homebrew Cellar path, not the /opt/homebrew/bin link): what the hook is pinned to. */
export function currentBun(execPath = process.execPath): string {
  try {
    return realFileSync(execPath)
  } catch {
    return execPath
  }
}

/** The deny the hook command prints when it cannot start: fixed JSON, no single quote in it (it rides in a shell's single quotes). */
export const GUARD_HOOK_GONE_JSON = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: GUARD_HOOK_GONE_REASON,
  },
}).replaceAll("'", '\\u0027')

/**
 * Why `p` cannot go in the hook command, or undefined. The command quotes each path in double quotes for a shell, where `$` and a
 * backtick still expand and a backslash, a double quote or a control character would not survive JSON's quoting as the same path.
 */
export function shellUnsafe(p: string): string | undefined {
  if (/[$`]/.test(p)) return 'it contains $ or a backtick, which a shell expands inside the quotes'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
  if (/["\\\u0000-\u001f\u007f]/.test(p)) return 'it contains a quote, a backslash or a control character'
  return undefined
}

/**
 * The hook's command line, one spelling for install and refresh. It fails closed only when it cannot start: when the pinned bun is
 * not an executable file or the checkout's cli.ts is gone, the shell prints the fixed deny (`GUARD_HOOK_GONE_JSON`) and exits 0, so
 * Claude Code blocks the call. When both are there the shell becomes the hook (`exec`), so its own answer, exit code and output are
 * exactly what they were: an allow, a deny, an exit 2, or a crash Claude Code treats as a non-blocking error.
 */
export function hookCommand(bun: string, checkout: string, rulesFile: string, sha: string): string {
  for (const p of [bun, checkout, rulesFile]) {
    const why = shellUnsafe(p)
    if (why) throw new Error(`${p} cannot be pinned in the guard hook: ${why}`)
  }
  const b = JSON.stringify(bun)
  const cli = JSON.stringify(join(checkout, 'apps', 'bridge', 'src', 'cli.ts'))
  return `[ -f ${b} ] && [ -x ${b} ] && [ -f ${cli} ] && ${BUN_CACHE_OFF.name}=${BUN_CACHE_OFF.value} exec ${b} ${cli} guard-hook --config ${JSON.stringify(rulesFile)} --sha ${sha} || printf '%s\\n' '${GUARD_HOOK_GONE_JSON}'`
}

/** The tools the hook is registered for (the PreToolUse matcher). */
export const HOOK_MATCHER = ['Bash', ...WRITE_TOOLS].join('|')

/**
 * The exact bytes of both guard files for these rules and this bun: the one builder `install-guards` and `guards refresh` share,
 * so a refresh writes what an install would write today, byte for byte. The rules go to their own file, named by their hash
 * (`rulesFileFor`), spelled under `home` as the hook names it.
 */
export function guardFiles(
  cfg: GuardConfig,
  bun: string,
  home: string,
): { rules: string; settings: string; sha: string; rulesFile: string } {
  const rules = `${JSON.stringify(cfg, null, 2)}\n`
  // the hook only trusts a rules file whose hash matches the one written here, into the settings file beside it
  const sha = createHash('sha256').update(rules).digest('hex')
  const rulesFile = rulesFileFor(home, sha)
  const settings = {
    permissions: { deny: denyRules(cfg) },
    hooks: {
      PreToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [{ type: 'command', command: hookCommand(bun, cfg.checkout, rulesFile, sha) }],
        },
      ],
    },
  }
  return { rules, settings: `${JSON.stringify(settings, null, 2)}\n`, sha, rulesFile }
}

/** `data` at `path`, complete on disk before the name points at it: a temp file, fsynced, renamed, the folder fsynced. */
export function writeDurable(path: string, data: string): void {
  const dir = dirname(path)
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
  closeSync(fd)
  try {
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  const d = openSync(dir, constants.O_RDONLY)
  try {
    fsyncSync(d)
  } catch {
    // some file systems refuse an fsync of a folder; the rename is done either way
  } finally {
    closeSync(d)
  }
}

/** The settings files a running session reads its hook from: the guards' own, Main's launch file and each thread's. */
function sessionSettings(home: string): string[] {
  const out = [guardsSettings(home), join(guardsDir(home), 'main-launch.json')]
  const workers = join(home, 'workers')
  let ids: string[] = []
  try {
    ids = readdirSync(workers)
  } catch {}
  for (const id of ids) out.push(join(workers, id, 'settings.json'))
  return out
}

/** A rules file nothing names is kept this long (from the first refresh that found it unnamed) before it is removed: a thread start
 * that read the guards' settings just before a refresh switched them writes its own settings, naming the old file, a moment later. */
export const COLLECT_GRACE_MS = 10 * 60_000
/** Which rules files have been found unnamed, and since when (ms): `<guards>/.collect.json`. */
export const COLLECT_STATE = '.collect.json'
const CONFIG_IN = /--config ("(?:[^"\\]|\\.)*")/g

/**
 * The rules files the settings files name, by their name in the guards folder; undefined when one settings file is there and cannot
 * be read as JSON (half written, too big): then nothing may be collected. Each file is parsed, and every hook command in it is read
 * for its `--config` path (the Mac writes `/` as `\/`, so the raw text is never matched).
 */
function namedRules(home: string): Set<string> | undefined {
  const dir = guardsDir(home)
  const named = new Set<string>()
  for (const f of sessionSettings(home)) {
    let text: string
    try {
      const st = lstatSync(f)
      if (!st.isFile() || st.size > 4 << 20) return undefined
      text = readFileSync(f, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      return undefined
    }
    let o: unknown
    try {
      o = JSON.parse(text)
    } catch {
      return undefined
    }
    const hooks = (o as { hooks?: unknown } | null)?.hooks
    if (typeof hooks !== 'object' || hooks === null) continue
    for (const entries of Object.values(hooks as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      for (const e of entries) {
        const list = (e as { hooks?: unknown } | null)?.hooks
        if (!Array.isArray(list)) continue
        for (const h of list) {
          const cmd = (h as { command?: unknown } | null)?.command
          if (typeof cmd !== 'string') continue
          for (const m of cmd.matchAll(CONFIG_IN)) {
            try {
              const p = JSON.parse(m[1] as string) as string
              if (join(real(dirname(p)), basename(p)) === join(real(dir), basename(p))) named.add(basename(p))
            } catch {}
          }
        }
      }
    }
  }
  return named
}

/**
 * Removes the rules files no settings file has named for `COLLECT_GRACE_MS` (the guards' own, Main's launch file, each thread's,
 * each parsed). A thread's settings file stays while the thread has one, live or parked, so its rules stay too: never one a
 * running session's hook still checks. A settings file that cannot be parsed stops all collection.
 */
export function collectRules(home: string, now = Date.now()): void {
  const dir = guardsDir(home)
  const named = namedRules(home)
  if (!named) return
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => RULES_FILE_NAME.test(n))
  } catch {
    return
  }
  const statePath = join(dir, COLLECT_STATE)
  let since: Record<string, number> = {}
  try {
    const o = JSON.parse(readFileSync(statePath, 'utf8')) as { v?: unknown; unnamed?: unknown }
    if (o.v === 1 && typeof o.unnamed === 'object' && o.unnamed !== null) since = o.unnamed as Record<string, number>
  } catch {}
  const next: Record<string, number> = {}
  for (const n of names) {
    if (named.has(n)) continue
    const t =
      typeof since[n] === 'number' && Number.isFinite(since[n]) && (since[n] as number) <= now
        ? (since[n] as number)
        : now
    if (now - t >= COLLECT_GRACE_MS) rmSync(join(dir, n), { force: true })
    else next[n] = t
  }
  const text = `${JSON.stringify({ v: 1, unnamed: next })}\n`
  if (Object.keys(next).length === 0) rmSync(statePath, { force: true })
  else if (JSON.stringify(since) !== JSON.stringify(next)) writeDurable(statePath, text)
}

/** What install-guards and the refresh say about a hook whose pinned bun is gone (measured; docs/SECURITY.md "The hook pins"). */
export const PINNED_BUN_NOTE =
  "The hook is pinned to this bun binary. If that file goes (a bun upgrade such as brew upgrade bun removes the old version's folder), the hook cannot start, and it then blocks every guarded tool call until the session restarts (it fails closed). The Mac app re-pins it at each start of Main (talos-app guards refresh) and restarts the sessions still pinned to the old bun; without the Mac app, run talos-app install-guards again after upgrading bun, then restart the agent."

export function runInstallGuards(
  a: { home: string; checkout: string; claudeHome: string; userHome?: string; bun?: string },
  args: string[],
  io: Out,
): number {
  const { values } = parseArgs({ args, options: { remove: { type: 'boolean' } }, strict: true })
  const dir = guardsDir(a.home)
  const settings = guardsSettings(a.home)
  if (values.remove) {
    rmSync(settings, { force: true })
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => RULES_FILE_NAME.test(n))
    } catch {}
    for (const n of names) rmSync(join(dir, n), { force: true })
    rmSync(join(dir, COLLECT_STATE), { force: true })
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
    io.out(
      'Guards removed. Restart the agent now: a session that is already running still calls the hook, which finds its rules gone and blocks every tool call until you do.',
    )
    return 0
  }
  const cfg = buildGuardConfig(a)
  let files: ReturnType<typeof guardFiles>
  try {
    files = guardFiles(cfg, a.bun ?? currentBun(), a.home)
  } catch (e) {
    io.err(`Guards not installed: ${(e as Error).message}. Nothing was written.`)
    return 1
  }
  ensureDir(dir)
  // the rules first, complete on disk, then the settings that name them; a file with these exact bytes is left as it is
  let have: Buffer | undefined
  try {
    have = readFileSync(files.rulesFile)
  } catch {}
  if (!have?.equals(Buffer.from(files.rules))) writeDurable(files.rulesFile, files.rules)
  writeDurable(settings, files.settings)
  collectRules(a.home)
  io.out(`Wrote ${settings} and ${files.rulesFile} (outside the agent folder).`)
  io.out(`They apply when the agent starts with: claude --settings ${settings}`)
  io.out(
    say({
      mac: '`talos-app start` and the Mac app add that flag by themselves while the file exists. Restart the agent for it to take effect.',
      linux:
        '`talos-app start` and the supervisor add that flag by themselves while the file exists. Restart the agent for it to take effect.',
    }),
  )
  io.out(PINNED_BUN_NOTE)
  io.out('Undo with: talos-app install-guards --remove')
  return 0
}

/**
 * The claude flags for `talos-app start`: one `--settings` with the guards (when installed) and Claude Code's own computer use
 * turned off (main-launch.ts). The owner's own `--settings` is kept, with the deny merged into a copy; then the guards are not
 * added and `warning` says so, as does any miss of the deny.
 */
export function withGuardsSettings(
  flags: string[],
  home: string,
  cwd?: string,
): { flags: string[]; warning?: string; refusal?: string; recheck?: () => string | null } {
  const r = mainLaunchArgs(flags, home, cwd ? { cwd } : {})
  if (r.refusal) return { flags, refusal: r.refusal }
  const own = r.warnings.find((w) => w.includes('the guards are NOT active'))
  const lines = r.warnings.map((w) =>
    w === own
      ? `WARNING: the guards are installed (${guardsSettings(home)}) but your flags already include --settings, and Claude Code reads only one. The guards are NOT active for this session. Put the guard rules into your own settings file, or drop your --settings.`
      : `WARNING: ${w}.`,
  )
  const recheck = r.recheck ? { recheck: r.recheck } : {}
  return lines.length ? { flags: r.args, warning: lines.join('\n'), ...recheck } : { flags: r.args, ...recheck }
}

export function cmdInstallGuards(env: BridgeEnv, args: string[], io: Out): number {
  let claudeHome: string
  try {
    claudeHome = claudeConfigDir(homedir(), process.env.CLAUDE_CONFIG_DIR)
  } catch (e) {
    io.err((e as Error).message)
    return 1
  }
  return runInstallGuards({ home: env.home, checkout: CHECKOUT, claudeHome }, args, io)
}
