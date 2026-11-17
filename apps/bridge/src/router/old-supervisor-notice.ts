// A dedicated sub-thread with no folder, or its parent's own, that an OLDER supervisor refuses: the bridge keeps such a shape out of
// the config while `subthreads_shared_folder` is off, so this is a hand edit or an app rolled back. The old supervisor's own words
// ("a session never shares its parent's folder") cannot change, so the bridge says it plainly in that thread, once per bridge run.
import { folderSame, parentThread, supervisorFresh, type WorkersFileT } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'

export const OLD_SUPERVISOR_LINE =
  "this thread can't start: the Talos app on this computer is older than its settings; update it"

/** What the Mac and Linux supervisors said before `subthreads_shared_folder` when a sub-thread had no folder or the parent's own. */
const OLD_REFUSAL = /folder of its own|inside its parent|its parent thread's folder|none of its own/i

/** Posts the line for each such thread whose start failed that way while the capability is off. `told` is the bridge run's memory. */
export function tellOldSupervisor(ctx: BridgeContext, file: WorkersFileT | null, told: Set<string>): void {
  if (!file || !supervisorFresh(file, ctx.clock.now()) || file.supervisor.subthreads_shared_folder === true) return
  const config = ctx.config.config
  for (const [id, e] of Object.entries(file.threads)) {
    if (told.has(id) || e.error?.code !== 'start_failed' || !OLD_REFUSAL.test(e.error.detail ?? '')) continue
    const t = config.threads.find((x) => x.id === id)
    const parent = parentThread(config, id)
    if (!t || !parent || t.session !== 'dedicated') continue
    const cwd = t.session_opts?.cwd
    const parentCwd = parent.session_opts?.cwd
    // only the new shape: no folder, or the parent's own; any other folder was refused by the old rules for the old reason
    if (cwd && !(parentCwd && folderSame(cwd, parentCwd))) continue
    told.add(id)
    void postSystemNotice(ctx, OLD_SUPERVISOR_LINE, { thread: threadRef(ctx, id) }).catch((err) => {
      told.delete(id) // not posted: the next look tries again
      ctx.log.warn('old-supervisor line not posted', { thread: id, error: (err as Error).message })
    })
  }
}
