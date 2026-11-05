// `talos-app install-subagent-tee --agent-dir <dir> [--scope project|user] [--dry-run]` (docs/SUBAGENTS.md 5.2). Opt-in:
// it sets `subagentStatusLine` in the agent folder's `.claude/settings.json` (or the user's, with --scope user) to the
// tee, only after showing the exact change and a y/N. An owner's own `subagentStatusLine` command is never replaced: it is
// wrapped (`subagent-tee -- /bin/sh -c '<original>'`), so its output still reaches the CLI. A dry run writes nothing;
// broken JSON, or a setting of a shape we do not know, stops the command before anything is touched.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defaultHome } from './config.ts'
import { writeFileAtomic } from './fsutil.ts'

export class TeeInstallError extends Error {}

/** POSIX single-quote quoting for a shell command line. */
export const shq = (s: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

const TEE_SCRIPT = resolve(dirname(import.meta.path), 'subagent-tee.ts')
const MARK = 'subagent-tee.ts'

/** The command the setting runs: bun on the tee script by absolute path, with TALOS_APP_HOME when it is not the default. */
export function teeCommand(home: string, bun = 'bun', script = TEE_SCRIPT): string {
  const env = resolve(home) === resolve(defaultHome()) ? '' : `TALOS_APP_HOME=${shq(home)} `
  return `${env}${shq(bun)} ${shq(script)}`
}

export type TeePlan = {
  path: string
  /** What the setting is now (undefined: not set). */
  before: unknown
  /** What it would become; undefined when nothing changes. */
  after: Record<string, unknown> | undefined
  /** The owner's own command is kept, run inside the tee. */
  wrapped: boolean
  next: Record<string, unknown>
  created: boolean
  raw: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function planSubagentTee(path: string, command: string): TeePlan {
  const created = !existsSync(path)
  const raw = created ? null : readFileSync(path, 'utf8')
  let cfg: Record<string, unknown> = {}
  if (raw !== null) {
    let v: unknown
    try {
      v = JSON.parse(raw)
    } catch {
      throw new TeeInstallError(`${path} is not valid JSON; fix it by hand first (nothing was changed)`)
    }
    if (!isObject(v)) throw new TeeInstallError(`${path} is not a JSON object (nothing was changed)`)
    cfg = { ...v }
  }
  const before = cfg.subagentStatusLine
  let after: Record<string, unknown> | undefined
  let wrapped = false
  if (before === undefined) after = { type: 'command', command }
  else {
    if (!isObject(before) || before.type !== 'command' || typeof before.command !== 'string')
      throw new TeeInstallError(
        `${path}: "subagentStatusLine" is not a command setting this installer knows; edit it by hand (nothing was changed)`,
      )
    if (before.command.includes(MARK))
      after = undefined // already the tee, or already wrapped
    else {
      after = { ...before, command: `${command} -- /bin/sh -c ${shq(before.command)}` }
      wrapped = true
    }
  }
  const next = after ? { ...cfg, subagentStatusLine: after } : cfg
  return { path, before, after, wrapped, next, created, raw }
}

export function describeTeePlan(plan: TeePlan): string[] {
  if (!plan.after) return [`${plan.path}: subagentStatusLine already runs the tee (nothing to change)`]
  const out = [`${plan.created ? 'would create' : 'would edit'} ${plan.path}`, '  subagentStatusLine:']
  if (plan.before !== undefined) out.push(`  - ${JSON.stringify(plan.before)}`)
  out.push(`  + ${JSON.stringify(plan.after)}`)
  out.push(
    plan.wrapped
      ? '  Your own command still runs, inside the tee, and its output still draws the rows.'
      : '  The tee prints nothing, so the CLI keeps its default subagent rows.',
  )
  return out
}

/** Writes the plan atomically, through a symlink, keeping the mode; refuses if the file changed since the plan. */
export function writeTeePlan(plan: TeePlan): void {
  const target = existsSync(plan.path) ? realpathSync(plan.path) : plan.path
  const now = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (now !== plan.raw)
    throw new TeeInstallError(`${plan.path} changed while waiting for your answer; nothing was written. Run it again.`)
  const mode = now === null ? 0o644 : statSync(target).mode & 0o777
  mkdirSync(dirname(target), { recursive: true })
  writeFileAtomic(target, `${JSON.stringify(plan.next, null, 2)}\n`, mode)
}
