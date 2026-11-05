// The real wake (HB4): write the run pack, then send the agent ONE `schedule_run` notification that names the pack and gives
// counts, and nothing a source wrote. Returns `awaiting`: the items are not shown until the run reports done ok.
import type { Notification, ThreadRef } from '../notify.ts'
import { heartbeatWakeNotification } from '../notify.ts'
import { buildPack, writePack } from './pack.ts'
import type { HeartbeatWake } from './runner.ts'

export type WakeDeps = {
  home: string
  now: () => number
  emit: (n: Notification) => Promise<void>
  thread: (jobId: string) => ThreadRef
  jobName: (jobId: string) => string
  log: (msg: string, f?: Record<string, unknown>) => void
  /** Whether the `heartbeat-triage` agent can be used. 'unknown' = the mod has not reported yet; nothing is woken either way. */
  available: () => 'yes' | 'no' | 'unknown'
  /** Called once the pack is written and the notification is out. */
  onSent?: (a: { runId: string; jobId: string }) => void
}

export function makeWake(d: WakeDeps): HeartbeatWake {
  return async (req) => {
    const avail = d.available()
    if (avail === 'no') return { delivered: false, unavailable: true }
    if (avail === 'unknown') return { delivered: false, unknown: true }
    const nowMs = d.now()
    const nowIso = new Date(nowMs).toISOString()
    let path: string
    let counts: ReturnType<typeof buildPack>['counts']
    try {
      const pack = buildPack({
        runId: req.run_id,
        jobId: req.job_id,
        runKey: req.run_key,
        nowIso,
        items: req.items,
        leftForNext: req.left_for_next_wake,
      })
      counts = pack.counts
      path = writePack(d.home, pack)
    } catch (e) {
      // no pack, no wake: the items are kept for the next slot (two tries at most), then become lines
      d.log('heartbeat pack not written', { error: (e as Error).message })
      return { delivered: false, retry: true }
    }
    try {
      await d.emit(
        heartbeatWakeNotification({
          thread: d.thread(req.job_id),
          runId: req.run_id,
          jobId: req.job_id,
          name: d.jobName(req.job_id),
          hitsPath: path,
          counts,
          ts: nowIso,
        }),
      )
    } catch (e) {
      d.log('heartbeat wake refused', { error: (e as Error).message })
      return { delivered: false, retry: true }
    }
    d.onSent?.({ runId: req.run_id, jobId: req.job_id })
    return { delivered: false, awaiting: true }
  }
}

/**
 * Whether `heartbeat-triage` can be used: `yes` when the Talos mod (plugin `talos-app-mod`, which ships the agent) is connected and
 * its inventory lists the plugin enabled; `no` only when the inventory IS there and the plugin is not in it; `unknown` when the
 * mod is not live yet or its inventory has not arrived (a bridge restart, a /reload-plugins), which is not proof of anything.
 * The inventory lists plugins, not their agents, so this is the nearest proof the bridge can get.
 */
export function triageAvailable(mod: {
  liveInventory(): { plugins: Array<{ name: string; enabled: boolean }> } | undefined
}): 'yes' | 'no' | 'unknown' {
  const inv = mod.liveInventory()
  if (!inv) return 'unknown'
  return inv.plugins.some((p) => p.name === 'talos-app-mod' && p.enabled) ? 'yes' : 'no'
}
