// talos-app doctor's guard-timeout row. A kit guard hook (action-rules and the other safety guards) that outlives its alarm
// (kit/hooks/_talos_common.py arm_guard_timeout) asks or denies instead of allowing, and writes one line to guard-timeouts.jsonl in
// the agent's hook state folder: {at, hook, seconds, unattended}. A slow guard rule is a bug, so any timeout in the last 7 days is a warning.
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Check } from './doctor-checks.ts'
import { gazetteerPath } from './memory/reflex.ts'

const WEEK_MS = 7 * 24 * 3600_000

export function guardTimeoutsCheck(
  agentDir: string,
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Check | undefined {
  // not a Talos agent folder (no kit hooks there): no row, as for the memory search row
  if (!existsSync(join(agentDir, 'hooks', '_talos_common.py'))) return undefined
  // the hook state folder, the same one the kit's state_dir() names (gazetteerPath mirrors it)
  const file = join(dirname(gazetteerPath(agentDir, env)), 'guard-timeouts.jsonl')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { level: 'ok', name: 'guard timeouts', detail: 'none (no guard has timed out)' }
  }
  const hooks = new Set<string>()
  let n = 0
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { at?: unknown; hook?: unknown }
      const at = typeof r.at === 'string' ? Date.parse(r.at) : Number.NaN
      if (!Number.isFinite(at) || at < now - WEEK_MS || at > now + 3600_000) continue
      n++
      hooks.add(typeof r.hook === 'string' ? r.hook : '?')
    } catch {
      // a line that is not JSON is not a timeout
    }
  }
  if (n === 0) return { level: 'ok', name: 'guard timeouts', detail: 'none in the last 7 days' }
  return {
    level: 'warn',
    name: 'guard timeouts',
    detail: `guard timeouts in the last 7 days: ${n} (hooks: ${[...hooks].sort().join(', ')}). A timed-out guard asks instead of allowing; a slow rule is a bug. Log: ${file}`,
  }
}

/**
 * What `python3 hooks/action-rules.py test` says is wrong with a rule file right now: the lines it prints as `FAIL <which> (<path>): <why>`.
 * It only reads the rule files (no log, no state). This is how doctor sees a broken file while the guard is switched off, when the hook
 * runs `check` no more and so writes no line of its own. Nothing when the hook is missing, python3 is, or the run does not finish.
 */
export function liveRuleProblems(agentDir: string, env: Record<string, string | undefined>): string[] {
  const hook = join(agentDir, 'hooks', 'action-rules.py')
  if (!existsSync(hook)) return []
  const r = spawnSync('python3', [hook, 'test'], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: agentDir,
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: agentDir, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (r.error || r.status === null) return []
  return failLines(r.stdout ?? '')
}

const failLines = (out: string): string[] =>
  out
    .split('\n')
    .filter((l) => l.startsWith('FAIL '))
    .map((l) => l.slice(5, 305))

/** The same as `liveRuleProblems`, without holding the process still while python runs (the bridge's own use of it; 5 s at most). */
export function liveRuleProblemsAsync(agentDir: string, env: Record<string, string | undefined>): Promise<string[]> {
  const hook = join(agentDir, 'hooks', 'action-rules.py')
  if (!existsSync(hook)) return Promise.resolve([])
  return new Promise((done) => {
    execFile(
      'python3',
      [hook, 'test'],
      {
        encoding: 'utf8',
        timeout: 5000,
        cwd: agentDir,
        env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: agentDir, PYTHONDONTWRITEBYTECODE: '1' },
      },
      (err, stdout) => {
        // `test` exits 1 when a file is broken, with its FAIL lines on stdout; a run that did not finish (no python3, the time limit) says nothing
        const e = err as (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null
        if (e && (e.killed || e.signal || typeof e.code !== 'number')) return done([])
        done(failLines(String(stdout ?? '')))
      },
    )
  })
}

/**
 * talos-app doctor's rule-files row. kit/hooks/action-rules.py writes one line to action-rules-unreadable.jsonl
 * ({at, file: 'shipped' | 'user', path, error, unattended}) whenever a rule file, the shipped one or the owner's, could not be read:
 * it then asks (live) or denies (unattended) every call it checks until the file is fixed. Any such line in the last 7 days is a
 * warning. So is a file that `action-rules.py test` finds broken right now, even with the guard switched off (then nothing is
 * stopped, and this row is the only sign).
 */
export function actionRulesUnreadableCheck(
  agentDir: string,
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Check | undefined {
  if (!existsSync(join(agentDir, 'hooks', '_talos_common.py'))) return undefined
  const file = join(dirname(gazetteerPath(agentDir, env)), 'action-rules-unreadable.jsonl')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // no log yet
  }
  let shipped: { n: number; error: string } | undefined
  let user: { n: number; error: string } | undefined
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { at?: unknown; file?: unknown; error?: unknown }
      const at = typeof r.at === 'string' ? Date.parse(r.at) : Number.NaN
      if (!Number.isFinite(at) || at < now - WEEK_MS || at > now + 3600_000) continue
      const error = typeof r.error === 'string' ? r.error.slice(0, 200) : '?'
      if (r.file === 'shipped') shipped = { n: (shipped?.n ?? 0) + 1, error }
      else user = { n: (user?.n ?? 0) + 1, error }
    } catch {
      // a line that is not JSON is not a report
    }
  }
  const broken = liveRuleProblems(agentDir, env)
  if (!shipped && !user && broken.length === 0)
    return {
      level: 'ok',
      name: 'action rules',
      detail: 'both rule files read fine, and none was unreadable in the last 7 days',
    }
  const parts: string[] = []
  if (broken.length > 0)
    parts.push(
      `right now: ${broken.join('; ')}. While the guard is on, a rule file it cannot read makes it ask before every action (refuse, when nobody can answer) until it is fixed; with the guard switched off nothing is stopped`,
    )
  if (shipped)
    parts.push(
      `the shipped rule file (hooks/action-rules.yaml) was unreadable ${shipped.n} time(s) in the last 7 days (${shipped.error}): every call asked or was refused. Reinstall or upgrade the kit`,
    )
  if (user)
    parts.push(
      `your rules file (~/.config/talos/action-rules.yaml) was unreadable ${user.n} time(s) in the last 7 days (${user.error}): every call asked or was refused until it was fixed`,
    )
  return { level: 'warn', name: 'action rules', detail: `${parts.join('. ')}. Log: ${file}` }
}
