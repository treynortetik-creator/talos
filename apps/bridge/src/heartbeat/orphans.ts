// A heartbeat source runs in a process group of its own and outlives a bridge crash. While it runs, the store holds its group id,
// the command it was started with and its start time (`running`). At bridge start, before any slot, this kills what a crash left:
// a group only if it is still alive and it is the one that was recorded. A group nobody recorded is never touched.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PsInfo } from '../lifecycle.ts'
import { killGroup, processInfo } from './spawn.ts'
import { loadStore, type Running, saveStore } from './store.ts'

/** Every job's store: live and shadow. */
const STORE_FILE = /^heartbeat-state\..+\.json$/

type Verdict = 'kill' | 'clear' | 'keep'

/** Whether a group with this id exists: `foreign` when it does but this user may not signal it (so it is not ours). */
function groupState(pgid: number): 'alive' | 'gone' | 'foreign' {
  try {
    process.kill(-pgid, 0)
    return 'alive'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? 'foreign' : 'gone'
  }
}

function judge(r: Running, info: (pid: number) => PsInfo | 'gone' | 'unknown'): Verdict {
  if (r.pgid <= 1 || r.pgid === process.pid || r.pgid === process.ppid) return 'clear'
  if (groupState(r.pgid) !== 'alive') return 'clear'
  // A group id cannot be handed out again while its group still has a member. So if the leader is gone and the group is alive, it
  // is the recorded one; if the leader is there, it must be the process that was recorded (same command, same start time).
  const leader = info(r.pgid)
  if (leader === 'unknown') return 'keep' // ps did not answer: no proof either way, the next start looks again
  if (leader === 'gone') return 'kill'
  return leader.command === r.command && (r.lstart === undefined || leader.lstart === r.lstart) ? 'kill' : 'clear'
}

export function reapOrphans(
  home: string,
  log: (msg: string, f?: Record<string, unknown>) => void,
  deps: { info?: (pid: number) => PsInfo | 'gone' | 'unknown' } = {},
): { killed: number[] } {
  const killed: number[] = []
  let files: string[]
  try {
    files = readdirSync(home).filter((f) => STORE_FILE.test(f))
  } catch {
    return { killed }
  }
  for (const f of files) {
    const path = join(home, f)
    const { store, corrupt } = loadStore(path, false) // a store that cannot be read is left exactly where it is
    if (corrupt || !Object.keys(store.running).length) continue
    for (const [id, r] of Object.entries(store.running)) {
      const v = judge(r, deps.info ?? processInfo)
      if (v === 'keep') continue
      if (v === 'kill') {
        killGroup(r.pgid, true) // the group only: a lone-pid signal could hit a process that reused the number
        killed.push(r.pgid)
        log('heartbeat source left running by an earlier bridge was stopped', { source: id })
      }
      delete store.running[id]
    }
    try {
      saveStore(path, store)
    } catch (e) {
      log('heartbeat store not saved after the sweep', { error: (e as Error).message })
    }
  }
  return { killed }
}
