// Problem reports waiting to be sent, kept in their own IndexedDB store (`problems`). NOT in `outbox` or `blobs`: those are
// the owner's own words waiting for delivery, and `countUnsent` counts them for the sign-in page. A report is nothing the
// owner asked to have delivered, so it never inflates that number; it is still wiped with the rest on sign-out and revoke
// (`discardUnsent`, `clearLocalData`).
import { Problem, type ProblemT } from '@talos-app/protocol'
import { TalosClientError } from '../../lib/client.ts'
import { HttpError } from '../../lib/http.ts'
import type { Storage } from '../../lib/storage.ts'

/** How many reports wait at once. Past this the oldest AUTOMATIC one is dropped (and counted); owner reports are kept. */
export const QUEUE_MAX = 50
export const OWNER_QUEUE_MAX = 5

export type QueuedProblem = {
  problem: ProblemT
  /** The screenshot, held until there is a connection to upload it with. */
  shot?: { type: string; name: string; bytes: ArrayBuffer }
  queued_at: number
}

export type PostResult = { ok: true } | { ok: false; status: number; error?: string } | { ok: false; network: true }

export type FlushDeps = {
  post(problem: ProblemT): Promise<PostResult>
  upload(blob: Blob, name: string): Promise<NonNullable<ProblemT['screenshot']>>
}

export type FlushResult = {
  sent: number
  kept: number
  /** Rows thrown away because the relay said they are not acceptable (a 400). */
  rejected: number
  /** Which reports those were, so a caller can tell whether its own was one of them. */
  rejectedIds: string[]
  stopped?: 'offline' | 'rate' | 'auth' | 'server'
}

export const KEY = (p: ProblemT) => p.id

const merge = (a: FlushResult, b: FlushResult): FlushResult => ({
  sent: a.sent + b.sent,
  kept: b.kept,
  rejected: a.rejected + b.rejected,
  rejectedIds: [...a.rejectedIds, ...b.rejectedIds],
  ...(b.stopped ? { stopped: b.stopped } : {}),
})

/** What a failed picture upload means for its row: the row waits for the reason given, or the picture can never go. */
function uploadVerdict(e: unknown): 'never' | NonNullable<FlushResult['stopped']> {
  if (e instanceof TalosClientError)
    return e.code === 'too_large' ? 'never' : e.code === 'rate_limited' ? 'rate' : 'offline'
  if (!(e instanceof HttpError)) return 'offline' // the request never got an answer
  if (e.status === 401 || e.status === 403) return 'auth'
  if (e.status === 429) return 'rate'
  if (e.status === 400 || e.status === 413 || e.status === 415) return 'never'
  return 'server'
}

export class ProblemQueue {
  /** Reports dropped from the queue to stay inside QUEUE_MAX since this page opened. */
  dropped = 0
  private flushing: Promise<FlushResult> | null = null
  constructor(private storage: Storage) {}

  async rows(): Promise<QueuedProblem[]> {
    const all = await this.storage.all<QueuedProblem>('problems')
    return all
      .filter((r) => r && typeof r === 'object' && Problem.safeParse(r.problem).success)
      .sort((a, b) => a.queued_at - b.queued_at)
  }

  async size(): Promise<number> {
    return (await this.rows()).length
  }

  async add(problem: ProblemT, now: number, shot?: QueuedProblem['shot']): Promise<void> {
    await this.storage.put('problems', KEY(problem), { problem, queued_at: now, ...(shot ? { shot } : {}) })
    const rows = await this.rows()
    const owner = rows.filter((r) => r.problem.kind === 'owner')
    // Owner reports can carry a 5 MB picture: keep only the newest few.
    for (const r of owner.slice(0, Math.max(0, owner.length - OWNER_QUEUE_MAX))) {
      await this.storage.del('problems', KEY(r.problem))
      this.dropped++
    }
    const autos = rows.filter((r) => r.problem.kind === 'auto')
    for (const r of autos.slice(0, Math.max(0, autos.length - QUEUE_MAX))) {
      await this.storage.del('problems', KEY(r.problem))
      this.dropped++
    }
  }

  /**
   * Sends what is waiting, oldest first, one at a time. Only one flush runs at a time. A second call waits for the running
   * one and then runs again, so a report added while that one ran is sent too (unless the first stopped: then it stays; or
   * threw: then the second call runs for itself). A network failure, a 401, a 5xx or a 429 stops the run and keeps
   * everything left; a 400 removes that one row (it will never be accepted) and carries on, and is counted so the caller
   * can say so. A picture that can never be uploaded (or is not an image) is left off: the words still go.
   * A retry uploads the picture again: the server drops uploaded media after a while, so a kept reference cannot be trusted.
   */
  flush(deps: FlushDeps): Promise<FlushResult> {
    if (this.flushing)
      return this.flushing.then(
        (a) => (a.stopped ? a : this.flush(deps).then((b) => merge(a, b))),
        () => this.flush(deps),
      )
    const run = this.run(deps).finally(() => {
      this.flushing = null
    })
    this.flushing = run
    return run
  }

  private async run(deps: FlushDeps): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, kept: 0, rejected: 0, rejectedIds: [] }
    const rows = await this.rows()
    for (const [i, row] of rows.entries()) {
      let problem = row.problem
      if (row.shot) {
        try {
          const ref = await deps.upload(new Blob([row.shot.bytes], { type: row.shot.type }), row.shot.name)
          // The report schema takes only an image: a text file named .png comes back as a file and would be refused.
          problem = ref.kind === 'image' ? { ...problem, screenshot: ref } : { ...problem, truncated: true }
        } catch (e) {
          const verdict = uploadVerdict(e)
          // The report matters more than its picture: one that can never go is left off, and the report says so.
          if (verdict === 'never') problem = { ...problem, truncated: true }
          else {
            // The picture could not go yet: try the whole row again next time rather than send a report that lost its picture.
            out.kept = rows.length - i
            out.stopped = verdict
            return out
          }
        }
      }
      const r = await deps.post(problem)
      if (r.ok) {
        await this.storage.del('problems', KEY(row.problem))
        out.sent++
        continue
      }
      if ('network' in r) {
        out.kept = rows.length - i
        out.stopped = 'offline'
        return out
      }
      if (r.status === 429) {
        out.kept = rows.length - i
        out.stopped = 'rate'
        return out
      }
      if (r.status === 401 || r.status === 403) {
        out.kept = rows.length - i
        out.stopped = 'auth'
        return out
      }
      if (r.status === 400) {
        await this.storage.del('problems', KEY(row.problem))
        out.rejected++
        out.rejectedIds.push(row.problem.id)
        continue
      }
      out.kept = rows.length - i
      out.stopped = 'server'
      return out
    }
    return out
  }
}
