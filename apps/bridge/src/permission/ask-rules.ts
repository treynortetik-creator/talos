// `talos-app install-ask-rules` (docs/CLAUDE-CODE.md C3.1). The owner runs Claude Code in bypass mode, where nothing
// prompts, so there is nothing to relay. An explicit `ask` rule still prompts in every mode (C1.6), so exactly these calls
// reach the phone and nothing else changes. The file is edited only when the owner runs this command and says yes; a dry
// run writes nothing; broken JSON stops the command before anything is touched.
//
// These rules are a speed bump, not a boundary. They ask the owner for the common spellings an agent uses. A rule is a glob
// on the command text, so an agent that tries can get past it with other spellings, a different capitalisation (a macOS disk
// ignores case in file names), odd spacing or indirection. Rollback and restore-last-good stay safe because each one shows what it
// will do, keeps a backup, and can be undone. Covering more spellings was tried and made the list far too long for little gain.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../fsutil.ts'

/**
 * Rules for one owner-only subcommand (`rollback`, `restore-last-good`). A rule is a glob on the command text, so "the word right after the program" can only be written as
 * literal spellings: the program name (`talos-app` or `talos`, the `cli.ts` or `talos.ts` file, or the `cli` package script), then an optional
 * closing quote, then spaces, a tab or a `--` separator, then the subcommand bare or quoted. Matching it anywhere later would ask on
 * `git add .../cli.ts .../rollback.ts` or a commit message.
 */
function subcommandRules(word: string): string[] {
  const out: string[] = []
  for (const prog of ['talos-app', 'talos', 'cli.ts', 'talos.ts', 'cli']) {
    for (const mid of [' ', '  ', '   ', '\t', ' -- ', '" ', "' ", '" -- ', "' -- "])
      out.push(`Bash(*${prog}${mid}${word}*)`)
    for (const q of ['"', "'"]) {
      out.push(`Bash(*${prog} ${q}${word}${q}*)`)
      out.push(`Bash(*${prog}${q} ${q}${word}${q}*)`)
    }
  }
  return out
}

/**
 * Generic defaults: deploys, publishes and merges, deletes, force-pushes (every `git push`), pipe-to-shell, and Talos's own
 * rollback. A rule matches the command text, so rollback has rules for the `talos-app` and `talos` wrappers (bare, `./`, by full path,
 * or quoted), the CLI files run directly (`bun run <path>/cli.ts rollback`, `talos.ts`) and the `pnpm cli rollback` script, each with
 * `rollback` right after the program name (see rollbackRules). It is not a sandbox: rollback started some other way (`bun -e`, another file)
 * is not caught.
 */
export const DEFAULT_ASK_RULES: readonly string[] = Object.freeze([
  'Bash(git push *)',
  'Bash(rm -rf *)',
  'Bash(rm -fr *)',
  'Bash(rm -r *)',
  'Bash(rm -R *)',
  'Bash(rm --recursive *)',
  'Bash(gh pr merge *)',
  'Bash(gh release create *)',
  'Bash(npm publish *)',
  'Bash(* deploy *)',
  'Bash(sh *)',
  'Bash(bash *)',
  ...subcommandRules('rollback'),
  ...subcommandRules('restore-last-good'),
])

export type AskRulesPlan = {
  path: string
  /** Rules that are not in the file yet, in order. */
  added: string[]
  /** Rules already in `permissions.ask`. */
  present: string[]
  /** The whole file as it would be written. */
  next: Record<string, unknown>
  /** The file does not exist yet. */
  created: boolean
  /** The file's text when planned (null when it did not exist); writePlan refuses if it changed since. */
  raw: string | null
}

export class AskRulesError extends Error {}

/** Where the settings file is: the agent folder's `.claude/settings.json`, or the user's (`claudeDir`, default ~/.claude). */
export function settingsPath(scope: 'project' | 'user', agentDir: string, claudeDir?: string): string {
  if (scope === 'project') return join(agentDir, '.claude', 'settings.json')
  return join(claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pure plan: merges the rules into `permissions.ask`, keeps every other key and entry, adds each rule at most once. */
export function planAskRules(path: string, rules: readonly string[] = DEFAULT_ASK_RULES): AskRulesPlan {
  let existing: unknown
  const created = !existsSync(path)
  const raw = created ? null : readFileSync(path, 'utf8')
  if (raw !== null) {
    try {
      existing = JSON.parse(raw)
    } catch {
      throw new AskRulesError(`${path} is not valid JSON; fix it by hand first (nothing was changed)`)
    }
    if (!isObject(existing)) throw new AskRulesError(`${path} is not a JSON object (nothing was changed)`)
  }
  const cfg: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  if (cfg.permissions !== undefined && !isObject(cfg.permissions))
    throw new AskRulesError(`${path}: "permissions" is not an object (nothing was changed)`)
  const permissions: Record<string, unknown> = isObject(cfg.permissions) ? { ...cfg.permissions } : {}
  if (permissions.ask !== undefined && !Array.isArray(permissions.ask))
    throw new AskRulesError(`${path}: "permissions.ask" is not a list (nothing was changed)`)
  const ask: unknown[] = Array.isArray(permissions.ask) ? [...permissions.ask] : []
  const added: string[] = []
  const present: string[] = []
  for (const rule of rules) {
    if (ask.includes(rule)) present.push(rule)
    else if (!added.includes(rule)) added.push(rule)
  }
  permissions.ask = [...ask, ...added]
  cfg.permissions = permissions
  return { path, added, present, next: cfg, created, raw }
}

/** A short, human diff: only the lines that would change. */
export function describePlan(plan: AskRulesPlan): string[] {
  const out = [`${plan.created ? 'would create' : 'would edit'} ${plan.path}`, '  permissions.ask:']
  for (const r of plan.present) out.push(`    ${r}   (already there)`)
  for (const r of plan.added) out.push(`  + ${r}`)
  if (plan.added.length === 0) out.push('  (nothing to add)')
  return out
}

/**
 * Writes the plan: through a symlink to its target (the link stays a link), keeping the file's mode (a 0600 file stays
 * 0600; a new file is 0644), atomically. Re-reads the file first and refuses if it changed after the plan was made, so
 * an edit made while the y/N prompt was open is never overwritten.
 */
export function writePlan(plan: AskRulesPlan): void {
  const target = existsSync(plan.path) ? realpathSync(plan.path) : plan.path
  const now = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (now !== plan.raw)
    throw new AskRulesError(
      `${plan.path} changed while waiting for your answer; nothing was written. Run the command again.`,
    )
  const mode = now === null ? 0o644 : statSync(target).mode & 0o777
  mkdirSync(dirname(target), { recursive: true })
  writeFileAtomic(target, `${JSON.stringify(plan.next, null, 2)}\n`, mode)
}

/** Headless `claude -p` runs have no dialog, so a call an ask rule catches is denied there (docs: headless, permissions). */
export function headlessWarning(rules: readonly string[]): string[] {
  return [
    '',
    'HEADLESS RUNS: these rules also apply to non-interactive `claude -p` jobs (scheduled jobs, backups).',
    'With nobody to answer, a call that matches an ask rule is DENIED there, bypass mode included; --allowedTools and',
    '--permission-mode cannot override an ask rule. A job that runs `git push` or `rm -r` in this folder will start failing.',
    'Rules that would affect them:',
    ...rules.map((r) => `    ${r}`),
    'Ways around it (docs.claude.com permissions + headless):',
    '  - start those jobs with `claude -p --setting-sources user ...`, so the project settings (and these rules) are not read',
    "    (it also skips the project's other settings and .mcp.json); or use `--scope user` only if you want them everywhere",
    '  - or answer them in the job with a PermissionRequest hook or `--permission-prompt-tool`',
    '  - `--permission-prompts none` only tells Claude not to retry a denied call; it does not allow it',
  ]
}

/** A rule's spelling without the differences Claude Code treats as the same: the older `:*` suffix, runs of spaces. */
export const normalizeRule = (rule: string): string => rule.replace(/:\*\)$/, ' *)').replace(/\s+/g, ' ')

/** Every settings file `doctor` reads for ask rules: the project's two and the user's. */
export function askRuleFiles(agentDir: string, claudeDir?: string): string[] {
  return [
    settingsPath('project', agentDir),
    join(agentDir, '.claude', 'settings.local.json'),
    settingsPath('user', agentDir, claudeDir),
  ]
}

/** The entries of `permissions.ask` in the file (none when it is missing, unreadable or not a list); used by `doctor`. */
export function askRulesIn(path: string): string[] {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { permissions?: { ask?: unknown } }
    const ask = cfg.permissions?.ask
    return Array.isArray(ask) ? ask.filter((r): r is string => typeof r === 'string') : []
  } catch {
    return []
  }
}
