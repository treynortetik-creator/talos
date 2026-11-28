// `talos-app guards refresh`: the installed guards rebuilt from THIS version's code, exactly as `install-guards` would write them
// today (the same builder, `guardFiles`), with the hook re-pinned to the bun running this command. The Mac app runs it before each
// start of Main, with a bun from a fixed list and the CLI of the checkout the guards name (GuardsRefresh.swift), so a release with new
// rules or a bun upgrade (the old Cellar folder gone) no longer needs the owner to run `install-guards` again.
//
// It installs nothing and removes nothing: it refuses unless both guard files are there, are plain files of this user in a plain
// folder of this user inside the Talos home, and are the pair an install wrote (settings.json names its rules file by the hash of
// its bytes). It refuses a checkout other than the one the guards were installed from (a moved checkout is the owner's install, in
// Terminal), and a bun inside the Talos home. It takes no input: no argument is accepted, and no environment variable, no file in
// the agent folder and nothing but the guards' own folder and this checkout's code decides what it writes. The facts fixed at
// install (Claude Code's folder, the user's home, the kit's folder) come from the installed rules file, which that hash vouches
// for; anything that can rewrite both files already has the guards (docs/SECURITY.md).
//
// The rules go to their own file, named by their hash, written in full before the settings that name it; an existing one is never
// written over, and an old one is removed only once no session's settings name it (`collectRules`), so a session still running on
// the old hook keeps checking its own rules. Nothing changed: nothing is written. Its one stdout line is for the Mac app, which
// parses it strictly: it names WHAT changed, never a rule.
import { closeSync, constants, lstatSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type { BridgeEnv } from '../config.ts'
import { BUN_CACHE_OFF } from '../mcp-config.ts'
import { processStartTime } from '../proc-identity.ts'
import { readRegularFile } from '../safe-open.ts'
import { parseGuardConfig } from './hook.ts'
import {
  CHECKOUT,
  collectRules,
  currentBun,
  GUARD_HOOK_GONE_JSON,
  guardFiles,
  HOOK_MATCHER,
  RULES_FILE_NAME,
  writeDurable,
} from './install.ts'
import { buildGuardConfig, type GuardConfig, real } from './rules.ts'

type Out = { out(l: string): void; err(l: string): void }

/** The first words of the one line the command prints on stdout. */
export const REFRESH_LINE = 'guards refresh:'
/** What a refresh can change, in the order the line names them. `settings`: the settings file differed in another way (the rules
 * file's name, the hook's shape). */
export const CHANGES = ['rules', 'bun', 'settings'] as const
export type Change = (typeof CHANGES)[number]
/** Why a refresh wrote nothing. One word each, the same words the Mac app knows. */
export const REFUSALS = [
  'arguments',
  'not-installed',
  'not-ours',
  'damaged',
  'unsafe',
  'other-home',
  'busy',
  'no-bun',
  'no-checkout',
  'checkout-moved',
] as const
export type Refusal = (typeof REFUSALS)[number]

const MAX_FILE = 1 << 20
const LOCK = '.refresh.lock'
const Q = '"(?:[^"\\\\]|\\\\.)*"'
const HEX = '([0-9a-f]{64})'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
type Shape = { re: RegExp; pick(m: RegExpExecArray): [string, string, string, string] | undefined }
/**
 * The hook commands install has written, each read back to its bun, cli.ts, rules file and hash. Another shape is one more entry here.
 * Current: fails closed when it cannot start (`hookCommand`). Before 2026-11-14: the bare command.
 */
const SHAPES: Shape[] = [
  {
    re: new RegExp(
      `^\\[ -f (${Q}) \\] && \\[ -x (${Q}) \\] && \\[ -f (${Q}) \\] && (?:${BUN_CACHE_OFF.name}=${BUN_CACHE_OFF.value} )?exec (${Q}) (${Q}) guard-hook --config (${Q}) --sha ${HEX} \\|\\| printf '%s\\\\n' '${esc(GUARD_HOOK_GONE_JSON)}'$`,
    ),
    pick: (m) =>
      m[1] === m[2] && m[1] === m[4] && m[3] === m[5]
        ? ([m[1], m[3], m[6], m[7]] as [string, string, string, string])
        : undefined,
  },
  {
    re: new RegExp(`^(${Q}) (${Q}) guard-hook --config (${Q}) --sha ${HEX}$`),
    pick: (m) => [m[1], m[2], m[3], m[4]] as [string, string, string, string],
  },
]

const under = (p: string, root: string) => p === root || p.startsWith(root + sep)
const uid = () => process.getuid?.() ?? -1

const SAYS: Record<Refusal, string> = {
  arguments: 'talos-app guards refresh takes no arguments.',
  'not-installed':
    'The guards are not installed here, and a refresh never installs them: run talos-app install-guards in Terminal.',
  'not-ours': 'The guard settings file is not the one talos-app install-guards writes. Nothing was changed.',
  damaged:
    'The guards rules file does not match the hash in the guard settings file (it was edited, or a file is missing or in the way), or it does not say where the kit is. Run talos-app install-guards again in Terminal.',
  unsafe:
    'The guards folder, one of its files or the bun is not where a refresh may write or pin (a link, another owner, shared write access, or inside the Talos home). Nothing was changed.',
  'other-home': 'The installed guards were made for another Talos home. Nothing was changed.',
  busy: 'Another guards refresh is running.',
  'no-bun': 'The bun running this command cannot be found on disk.',
  'no-checkout': "This checkout's apps/bridge/src/cli.ts cannot be found.",
  'checkout-moved':
    'This is not the checkout the guards were installed from. To use another checkout, run talos-app install-guards from it in Terminal. Nothing was changed.',
}

function refuse(io: Out, why: Refusal): number {
  io.out(`${REFRESH_LINE} refused ${why}`)
  io.err(SAYS[why])
  return why === 'arguments' ? 2 : 1
}

/** A plain file of this user with one name, not a link: 'ok'. Gone: 'missing'. Anything else: 'unsafe'. */
function plainFile(path: string): 'ok' | 'missing' | 'unsafe' {
  try {
    const st = lstatSync(path)
    return st.isFile() && st.nlink === 1 && st.uid === uid() && (st.mode & 0o022) === 0 ? 'ok' : 'unsafe'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
}

function plainFolder(path: string): 'ok' | 'missing' | 'unsafe' {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && st.uid === uid() && (st.mode & 0o022) === 0 ? 'ok' : 'unsafe'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
}

type Hook = { bun: string; cli: string; config: string; sha: string }

/** The guard hook in a settings file, only in a shape install writes: one PreToolUse entry with one command hook, ours. */
export function ourHook(settings: unknown): Hook | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined
  const pre = (settings as { hooks?: { PreToolUse?: unknown } }).hooks?.PreToolUse
  if (!Array.isArray(pre) || pre.length !== 1) return undefined
  const hooks = (pre[0] as { hooks?: unknown } | null)?.hooks
  if (!Array.isArray(hooks) || hooks.length !== 1) return undefined
  const h = hooks[0] as { type?: unknown; command?: unknown } | null
  if (h?.type !== 'command' || typeof h.command !== 'string') return undefined
  for (const shape of SHAPES) {
    const m = shape.re.exec(h.command)
    const parts = m && shape.pick(m)
    if (!parts) continue
    try {
      const [bun, cli, config] = parts.slice(0, 3).map((q) => JSON.parse(q) as string)
      if (!bun || !cli?.endsWith('/apps/bridge/src/cli.ts') || !config) return undefined
      return { bun, cli, config, sha: parts[3] }
    } catch {
      return undefined
    }
  }
  return undefined
}

const gone = (path: string) => {
  try {
    unlinkSync(path)
  } catch {}
}

/** The lock's holder is alive only when its pid runs AND started when the lock says: a reused pid is no holder. */
function holderAlive(text: string): boolean {
  const m = /^(\d+) (.+)$/.exec(text.trim())
  if (!m) return false
  const pid = Number(m[1])
  return pid > 1 && processStartTime(pid) === m[2]
}

/** One refresh at a time per home. A lock whose holder is gone (killed midway, or its pid reused) is taken over. */
function takeLock(path: string): boolean {
  const me = `${process.pid} ${processStartTime(process.pid) ?? 'unknown'}`
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, me)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (holderAlive(readRegularFile(path, 256)?.toString('utf8') ?? '')) return false
    gone(path)
  }
  return false
}

/** The kit folder the installed rules protect: the last protected path, as `buildGuardConfig` puts it. Not there: undefined. */
function installedKitDir(c: GuardConfig): string | undefined {
  const last = c.protectedPaths.at(-1)
  return last && !under(last, c.checkout) ? last : undefined
}

export function runGuardsRefresh(
  a: { home: string; checkout: string; bun: string; now?: number },
  args: string[],
  io: Out,
): number {
  if (args.length > 0) return refuse(io, 'arguments')
  const home = real(a.home)
  const dir = join(home, 'guards')
  const folder = plainFolder(dir)
  if (folder !== 'ok') return refuse(io, folder === 'missing' ? 'not-installed' : 'unsafe')
  const s = plainFile(join(dir, 'settings.json'))
  if (s !== 'ok') return refuse(io, s === 'missing' ? 'not-installed' : 'unsafe')
  // one at a time, and every read after the lock: a refresh that read the files before another one wrote them would compare
  // against bytes that are gone
  const lock = join(dir, LOCK)
  try {
    if (!takeLock(lock)) return refuse(io, 'busy')
  } catch {
    return refuse(io, 'unsafe')
  }
  try {
    return refreshLocked(a, home, dir, io)
  } finally {
    gone(lock)
  }
}

function refreshLocked(
  a: { home: string; checkout: string; bun: string; now?: number },
  home: string,
  dir: string,
  io: Out,
): number {
  const settingsPath = join(dir, 'settings.json')
  const oldSettings = readRegularFile(settingsPath, MAX_FILE)
  if (!oldSettings) return refuse(io, 'unsafe')
  let parsed: unknown
  try {
    parsed = JSON.parse(oldSettings.toString('utf8'))
  } catch {
    return refuse(io, 'not-ours')
  }
  const hook = ourHook(parsed)
  // the rules file it names: in the guards folder, under a rules file's name, and (content addressed) named by the hash it holds
  const rulesPath = hook && join(real(dirname(hook.config)), basename(hook.config))
  if (!hook || !rulesPath || dirname(rulesPath) !== dir || !RULES_FILE_NAME.test(basename(rulesPath)))
    return refuse(io, 'not-ours')
  if (basename(rulesPath) !== 'guards.json' && basename(rulesPath) !== `guards-${hook.sha}.json`)
    return refuse(io, 'not-ours')
  const r = plainFile(rulesPath)
  if (r === 'unsafe') return refuse(io, 'unsafe')
  if (r === 'missing') return refuse(io, 'damaged')
  const oldRules = readRegularFile(rulesPath, MAX_FILE)
  if (!oldRules) return refuse(io, 'unsafe')

  let bun: string
  try {
    bun = real(a.bun)
    if (!statSync(bun).isFile()) return refuse(io, 'no-bun')
  } catch {
    return refuse(io, 'no-bun')
  }
  const checkout = real(a.checkout)
  if (plainFile(join(checkout, 'apps', 'bridge', 'src', 'cli.ts')) === 'missing') return refuse(io, 'no-checkout')
  // never a bun or a checkout inside the Talos home: a session can write there
  if (under(bun, home) || under(checkout, home)) return refuse(io, 'unsafe')

  let installed: GuardConfig
  try {
    installed = parseGuardConfig(oldRules, hook.sha)
  } catch {
    return refuse(io, 'damaged')
  }
  if (real(installed.home) !== home) return refuse(io, 'other-home')
  // the checkout the guards were installed from, and no other: a copy elsewhere (an agent folder's) is never pinned (R1-1)
  if (checkout !== installed.checkout) return refuse(io, 'checkout-moved')
  // where the kit is comes from the installed rules, never from this run's environment (R1-5)
  const kitDir = installedKitDir(installed)
  if (!kitDir) return refuse(io, 'damaged')

  const cfg = buildGuardConfig({
    home: a.home,
    checkout,
    claudeHome: installed.claudeHome,
    userHome: installed.userHome,
    kitDir,
  })
  // a path a shell would expand inside the hook's quotes is never pinned
  let files: ReturnType<typeof guardFiles>
  try {
    files = guardFiles(cfg, bun, a.home)
  } catch {
    return refuse(io, 'unsafe')
  }
  const target = join(dir, basename(files.rulesFile))
  // a rules file of this name already there must hold exactly these bytes: it is never written over (a session may check it)
  const there = plainFile(target)
  if (there === 'unsafe') return refuse(io, 'damaged')
  if (there === 'ok' && !readRegularFile(target, MAX_FILE)?.equals(Buffer.from(files.rules)))
    return refuse(io, 'damaged')
  const settingsSame = oldSettings.equals(Buffer.from(files.settings))
  if (there === 'ok' && settingsSame) {
    collectRules(a.home, a.now)
    io.out(`${REFRESH_LINE} unchanged`)
    return 0
  }
  const next = JSON.parse(files.settings) as { permissions: unknown }
  const old = parsed as { permissions?: unknown; hooks: { PreToolUse: [{ matcher?: unknown }] } }
  const changed = new Set<Change>()
  if (
    files.sha !== hook.sha ||
    JSON.stringify(old.permissions) !== JSON.stringify(next.permissions) ||
    old.hooks.PreToolUse[0].matcher !== HOOK_MATCHER
  )
    changed.add('rules')
  if (hook.bun !== bun) changed.add('bun')
  // the same rules under another file name (an install from before content addressing)
  if (files.sha === hook.sha && hook.config !== files.rulesFile) changed.add('settings')
  if (changed.size === 0) changed.add('settings')

  // the rules first, complete on disk; then the settings that name them. Killed between the two: the old settings still name the
  // old rules, which are still there, and the next refresh finishes
  if (there === 'missing') writeDurable(target, files.rules)
  if (!settingsSame) writeDurable(settingsPath, files.settings)
  collectRules(a.home, a.now)
  io.out(`${REFRESH_LINE} changed ${CHANGES.filter((c) => changed.has(c)).join(' ')}`)
  return 0
}

/** `talos-app guards refresh`. The home is the one this CLI runs for; the checkout and the bun are the ones running this code. */
export function cmdGuards(env: BridgeEnv, args: string[], io: Out): number {
  const [sub, ...rest] = args
  if (sub !== 'refresh') {
    io.err('usage: talos-app guards refresh')
    return 2
  }
  return runGuardsRefresh({ home: env.home, checkout: CHECKOUT, bun: currentBun() }, rest, io)
}
