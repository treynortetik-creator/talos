// What Main's launch says about itself, where the launch is made (worker-policy.ts mainArgsWithGuards): the audit line for what the
// guards missed, and, when config.json could not be read, one audit line (which way the extra lock was kept) and, only when it was kept
// on, one plain notice.
import type { MainLaunch } from '../guards/main-launch.ts'
import type { MainEvent } from './notices.ts'

export function sayLaunch(
  r: MainLaunch,
  d: { audit: (e: string, f?: Record<string, string>) => void; tell?: (e: MainEvent) => void },
): void {
  if (r.warnings.length) d.audit('guards_not_applied', { why: r.warnings.join('; ') })
  if (r.unreadable)
    d.audit('os_sandbox_config_unreadable', {
      why: r.unreadable.why,
      lock: r.unreadable.keptOn ? 'kept on' : 'kept off',
    })
  if (r.notRecorded)
    d.audit('os_sandbox_record_failed', {
      why: 'the lock is on but could not be written down as the last good reading',
    })
  if (r.note) d.tell?.({ kind: 'lock_note', text: r.note })
}
