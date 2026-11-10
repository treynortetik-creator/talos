// The service's touch point for job memory of background jobs (docs/SCHEDULES.md "Job memory"), kept out of service.ts: which jobs
// have a pack, pointing Chronos at the folder, keeping the packs in step, and taking finished runs back in. Runs after every refresh
// of the live bridge; a Chronos without the `memory` feature is left alone (the card says it needs a newer one).
import { runsInSession, type ScheduleSnapshotT } from '@talos-app/protocol'
import type { ChronosAdapter } from './chronos-adapter.ts'
import type { JobMemory } from './job-memory.ts'
import { ingestReceipts, type PackJob, syncPacks } from './job-memory-headless.ts'
import type { Sidecar } from './sidecar.ts'
import { hasHeartbeatMeta } from './worker-scope.ts'

/** What the service keeps between refreshes: what each job's memory is bound to, by revision of the job. */
export type BackgroundMemoryState = {
  shas: Map<string, { etag: string; sha: string }>
  /** The syncs run one after another: two at once would each take the same finished run in. */
  tail: Promise<unknown>
}
export const newBackgroundMemoryState = (): BackgroundMemoryState => ({
  shas: new Map(),
  tail: Promise.resolve(),
})

/** A receipt, out file or scratch folder nobody took in is swept after this long (the sidecar keeps run ids as long). */
const RUN_FILES_KEEP_MS = 8 * 24 * 3600_000

/**
 * The jobs that get a pack: a Claude job that runs in the background (a restricted one only reads its results) and a command job
 * (files).
 */
function packJobs(
  snap: ScheduleSnapshotT,
  sidecar: Sidecar,
): Array<{ id: string; etag: string; kind: PackJob['kind'] }> {
  return snap.schedules
    .filter((s) => sidecar.memoryOf(s.id) && !runsInSession(s) && !hasHeartbeatMeta(s.meta))
    .map((s) => ({
      id: s.id,
      etag: s.etag,
      kind: s.kind === 'command' ? 'command' : s.permissions === 'restricted' ? 'results' : 'notes',
    }))
}

export function syncBackgroundMemory(d: Parameters<typeof syncOnce>[0]): Promise<void> {
  const next = d.state.tail.then(() => syncOnce(d))
  d.state.tail = next.catch(() => {})
  return next
}

async function syncOnce(d: {
  chronos: ChronosAdapter | null
  mem: JobMemory
  sidecar: Sidecar
  snap: ScheduleSnapshotT
  state: BackgroundMemoryState
  now: () => number
  /** The `memory_dir` in Chronos's config file now (undefined: none, or the file cannot be read). */
  memoryDirNow: () => string | undefined
}): Promise<void> {
  const { chronos, mem, sidecar, snap, state } = d
  if (!chronos?.hasFeature('memory')) return
  const wanted = packJobs(snap, sidecar)
  // Looked at on every sync, not once: anything with a shell on this Mac can change Chronos's config, and a repointed memory_dir would
  // have its runs read packs from, and leave receipts in, a folder that is not ours.
  if (wanted.length > 0 && d.memoryDirNow() !== mem.folderPath && mem.ensureFolder())
    await chronos.configSet({ memoryDir: mem.folderPath })
  const jobs: PackJob[] = []
  for (const j of wanted) {
    let t = state.shas.get(j.id)
    if (t?.etag !== j.etag) {
      const sha = await chronos.memoryBinding(j.id)
      t = sha ? { etag: j.etag, sha } : undefined
      if (t) state.shas.set(j.id, t)
      else state.shas.delete(j.id)
    }
    if (t) jobs.push({ id: j.id, sha: t.sha, kind: j.kind })
  }
  mem.sweepRuns(d.now() - RUN_FILES_KEEP_MS)
  syncPacks({ mem, sidecar, jobs })
  let kept = 0
  for (const j of jobs) {
    kept += await ingestReceipts(
      {
        mem,
        sidecar,
        now: d.now,
        shaOf: (id) => state.shas.get(id)?.sha,
        runOf: (id, runId) => chronos.runResult(id, runId),
      },
      j.id,
      { command: j.kind === 'command' },
    )
  }
  if (kept > 0) syncPacks({ mem, sidecar, jobs }) // the next run is offered what this one just left
}
