// talos-app doctor's guard-timeout row. A kit guard hook (action-rules and the other safety guards) that outlives its alarm
// (kit/hooks/_talos_common.py arm_guard_timeout) asks or denies instead of allowing, and writes one line to guard-timeouts.jsonl in
// the agent's hook state folder: {at, hook, seconds, unattended}. A slow guard rule is a bug, so any timeout in the last 7 days is a warning.
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
