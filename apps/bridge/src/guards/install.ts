// `talos-app install-guards [--remove]`: writes the PreToolUse guard hook and the permission deny rules to
// <home>/guards/, which is outside the agent folder. Nothing runs them until the agent is started with
// `claude --settings <home>/guards/settings.json` (`talos-app start` adds that by itself once the file exists).
// Never run by default; idempotent; `--remove` deletes exactly what it wrote.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { BridgeEnv } from '../config.ts'
import { ensureDir, writeJsonAtomic } from '../fsutil.ts'
import { buildGuardConfig, denyRules, WRITE_TOOLS } from './rules.ts'

type Out = { out(l: string): void; err(l: string): void }
const CHECKOUT = resolve(import.meta.dir, '..', '..', '..', '..')

export const guardsDir = (home: string) => join(home, 'guards')
export const guardsSettings = (home: string) => join(guardsDir(home), 'settings.json')

export function runInstallGuards(
  a: { home: string; checkout: string; claudeHome: string; userHome?: string },
  args: string[],
  io: Out,
): number {
  const { values } = parseArgs({ args, options: { remove: { type: 'boolean' } }, strict: true })
  const dir = guardsDir(a.home)
  const settings = guardsSettings(a.home)
  const rulesFile = join(dir, 'guards.json')
  if (values.remove) {
    rmSync(settings, { force: true })
    rmSync(rulesFile, { force: true })
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
    io.out(
      'Guards removed. Restart the agent now: a session that is already running still calls the hook, which finds its rules gone and blocks every tool call until you do.',
    )
    return 0
  }
  const cfg = buildGuardConfig(a)
  ensureDir(dir)
  writeJsonAtomic(rulesFile, cfg, 0o600)
  // the hook only trusts a rules file whose hash matches the one written here, into the settings file beside it
  const sha = createHash('sha256').update(readFileSync(rulesFile)).digest('hex')
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(cfg.checkout, 'apps', 'bridge', 'src', 'cli.ts'))} guard-hook --config ${JSON.stringify(rulesFile)} --sha ${sha}`
  writeJsonAtomic(
    settings,
    {
      permissions: { deny: denyRules(cfg) },
      hooks: { PreToolUse: [{ matcher: ['Bash', ...WRITE_TOOLS].join('|'), hooks: [{ type: 'command', command }] }] },
    },
    0o600,
  )
  io.out(`Wrote ${settings} and ${rulesFile} (outside the agent folder).`)
  io.out(`They apply when the agent starts with: claude --settings ${settings}`)
  io.out(
    '`talos-app start` and the Mac app add that flag by themselves while the file exists. Restart the agent for it to take effect.',
  )
  io.out(
    'The hook is pinned to this bun binary. After a bun upgrade (for example brew upgrade bun) the hook may fail to start; the deny rules still apply. Re-run talos-app install-guards after upgrading bun.',
  )
  io.out('Undo with: talos-app install-guards --remove')
  return 0
}

/**
 * The claude flags for a start, with the guards' settings added when the owner installed them. Claude Code takes one
 * `--settings`, so when the owner's own flags already carry one the guards are not added and `warning` says so.
 */
export function withGuardsSettings(flags: string[], home: string): { flags: string[]; warning?: string } {
  const file = guardsSettings(home)
  if (!existsSync(file)) return { flags }
  if (flags.some((f) => f === '--settings' || f.startsWith('--settings=')))
    return {
      flags,
      warning: `WARNING: the guards are installed (${file}) but your flags already include --settings, and Claude Code reads only one. The guards are NOT active for this session. Put the guard rules into your own settings file, or drop your --settings.`,
    }
  return { flags: [...flags, '--settings', file] }
}

export function cmdInstallGuards(env: BridgeEnv, args: string[], io: Out): number {
  return runInstallGuards(
    { home: env.home, checkout: CHECKOUT, claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') },
    args,
    io,
  )
}
