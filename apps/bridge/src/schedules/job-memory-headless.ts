// Job memory for background jobs (docs/SCHEDULES.md "Job memory"). Chronos starts a background run by itself, so the bridge cannot
// hand it a prompt. Instead the live bridge keeps one small pack file per job that Chronos appends to the prompt (only when it
// was written for the job text on disk), and takes the run back afterwards from the receipt Chronos left and the notepad file the
// run wrote. Everything a run wrote is data: it is cut, shown without hidden characters, and wrapped again on the way out.
import { createHash } from 'node:crypto'
import { type JobMemory, type JobMemoryData, memoryPromptBlock } from './job-memory.ts'
import type { Sidecar } from './sidecar.ts'

/** What Chronos will read of a pack. A bigger one is skipped there, so none is written bigger. */
export const PACK_MAX_BYTES = 8192
/** A receipt for a run Chronos no longer lists is dropped after this long. */
const RECEIPT_KEEP_MS = 8 * 24 * 3600_000
const NOTEPAD_INPUT_CHARS = 16 * 1024
const SUMMARY_CHARS = 280

/**
 * `notes`: the run may rewrite a notepad. `results`: it only reads the last results (a restricted job has no way to write one).
 * `command`: a script, which gets the notepad and the results as files and may rewrite the notepad.
 */
export type PackKind = 'notes' | 'results' | 'command'
/** `sha` is what the pack is bound to, as Chronos hashes it (sha256 hex of the job's prompt.md, or of a command job's kind and command). */
export type PackJob = { id: string; sha: string; kind: PackKind }
type PackInput = PackJob & { epoch: string; data: JobMemoryData | null }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const bytes = (s: string) => Buffer.byteLength(s)

/** What the pack says, without its random wrapper marker: two packs with the same key tell a run the same thing. */
function packKey(a: PackInput): string {
  return sha256(JSON.stringify([a.sha, a.epoch, a.kind, a.data]))
}

/** The pack file's text: the job, the hash of its text, the epoch, and the wrapped memory. Chronos adds where to write a notepad. */
export function buildPack(a: PackInput): string {
  const make = (d: JobMemoryData | null) =>
    JSON.stringify({
      v: 1,
      job: a.id,
      prompt_sha256: a.sha,
      epoch: a.epoch,
      notepad: a.kind !== 'results',
      key: packKey(a),
      text: memoryPromptBlock(d, a.kind === 'results' ? 'results' : 'pack'),
      // a command job's files: Chronos puts these in the run's own folder
      ...(a.kind === 'command'
        ? {
            notepad_text: d?.notepad ?? '',
            results_text: (d?.results ?? []).map((r) => `${r.ds} ${r.ok ? 'ok' : 'failed'}: ${r.summary}`).join('\n'),
          }
        : {}),
    })
  let data = a.data
  let out = make(data)
  // too big for Chronos: the oldest results go first, then the end of the notepad
  while (data && bytes(out) > PACK_MAX_BYTES && data.results.length > 0) {
    data = { ...data, results: data.results.slice(0, -1) }
    out = make(data)
  }
  while (data && bytes(out) > PACK_MAX_BYTES && data.notepad.length > 0) {
    data = {
      ...data,
      truncated: true,
      notepad: [...data.notepad].slice(0, Math.floor(data.notepad.length / 2)).join(''),
    }
    out = make(data)
  }
  return out
}

/**
 * Brings every pack in line with the memory: one for each background job that has memory on (written only when what it says
 * changed), none for any other. The read can wipe a file bound to other job text, which moves the epoch; the pack carries the epoch
 * after that. Only the live bridge writes (the memory store checks the gate).
 */
export function syncPacks(d: { mem: JobMemory; sidecar: Sidecar; jobs: PackJob[] }): {
  written: string[]
  removed: string[]
} {
  const written: string[] = []
  const removed: string[] = []
  const wanted = new Set<string>()
  for (const j of d.jobs) {
    if (!d.sidecar.memoryOf(j.id)) continue
    wanted.add(j.id)
    if (d.sidecar.memoryEpoch(j.id) === undefined) d.sidecar.bumpEpoch(j.id) // a switch from before epochs: give it one
    const first = d.sidecar.memoryEpoch(j.id)
    if (first === undefined) continue
    const data = d.mem.read(j.id, `${j.sha}.${first}`)
    const input: PackInput = { ...j, epoch: d.sidecar.memoryEpoch(j.id) ?? first, data }
    let cur: { key?: unknown } | null = null
    try {
      const raw = d.mem.readPack(j.id)
      cur = raw ? (JSON.parse(raw) as { key?: unknown }) : null
    } catch {
      cur = null
    }
    if (cur?.key === packKey(input)) continue
    if (d.mem.writePack(j.id, buildPack(input))) written.push(j.id)
  }
  for (const id of d.mem.packIds()) if (!wanted.has(id) && d.mem.removePack(id)) removed.push(id)
  return { written, removed }
}

export type RunResult = { status: string; ds: string; report: string | null; trigger: string }
export type IngestDeps = {
  mem: JobMemory
  sidecar: Sidecar
  now: () => number
  /** What the job's memory is bound to now (see PackJob.sha), or undefined when it cannot be read (nothing is kept then). */
  shaOf: (id: string) => string | undefined
  /** What Chronos says about a run: null when it is unknown or has not finished. */
  runOf: (id: string, runId: string) => Promise<RunResult | null>
}
const FINISHED = new Set(['ok', 'failed', 'timed_out', 'launch_stalled', 'session_ended'])

type Receipt = { job: string; run_id: string; epoch: string; prompt_sha256: string; notepad: boolean }
function receiptOf(raw: unknown): Receipt | null {
  const r = raw as Record<string, unknown> | null
  if (typeof r !== 'object' || r === null || r.v !== 1) return null
  const { job, run_id, epoch, prompt_sha256, notepad } = r
  if (typeof job !== 'string' || typeof run_id !== 'string' || typeof epoch !== 'string') return null
  if (typeof prompt_sha256 !== 'string' || typeof notepad !== 'boolean') return null
  return { job, run_id, epoch, prompt_sha256, notepad }
}

/**
 * One line a run leaves in the job's results: the first line of its report, or what became of it. A command's is its LAST output
 * line (a script prints its answer last) with the exit status in front ("exit 0"; Chronos tells a failed command only as failed).
 */
export function summaryOf(status: string, report: string | null, command = false): string {
  const lines = (report ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*#+\s*/, '').trim())
    .filter((l) => l.length > 0)
  const line = command ? lines[lines.length - 1] : lines[0]
  if (command && status === 'ok') return [...`exit 0${line ? `: ${line}` : ''}`].slice(0, SUMMARY_CHARS).join('')
  return line ? [...line].slice(0, SUMMARY_CHARS).join('') : `Run ended: ${status}`
}

/**
 * Takes the finished background runs of one job into its memory, oldest first. A run counts only if it was given the memory that is
 * still the job's now (same epoch, same job text); anything else is dropped without touching the memory. The run id is recorded
 * BEFORE the memory is written, so a restart can lose a result but never count one twice. Returns how many runs were kept.
 */
export async function ingestReceipts(d: IngestDeps, id: string, o: { command?: boolean } = {}): Promise<number> {
  let kept = 0
  for (const r of d.mem.receipts(id)) {
    const rc = receiptOf(r.raw)
    // the file name decides whose it is; a receipt that says another job (or another run) is not trusted for either
    if (!rc || rc.job !== id || rc.run_id !== r.runId) {
      d.mem.clearRun(id, r.runId)
      continue
    }
    if (d.sidecar.ingested(id, r.runId)) {
      d.mem.clearRun(id, r.runId)
      continue
    }
    const res = await d.runOf(id, r.runId)
    if (res?.trigger === 'event') {
      // an event run is never given memory, so a receipt for one was not made by Chronos: its input is untrusted and is not kept
      d.mem.clearRun(id, r.runId)
      continue
    }
    if (d.sidecar.ingested(id, r.runId)) {
      d.mem.clearRun(id, r.runId) // another pass took it in while Chronos was being asked
      continue
    }
    if (!res || !FINISHED.has(res.status)) {
      if (d.now() - r.mtimeMs > RECEIPT_KEEP_MS) d.mem.clearRun(id, r.runId)
      continue
    }
    if (!d.sidecar.markIngested(id, r.runId, d.now())) break // not the live bridge: the receipt stays for the one that is
    const bound = d.shaOf(id)
    const current =
      d.sidecar.memoryOf(id) &&
      d.sidecar.memoryEpoch(id) === rc.epoch &&
      bound !== undefined &&
      bound === rc.prompt_sha256
    if (current) {
      const notepad = !rc.notepad
        ? null
        : o.command
          ? d.mem.readScratchNotepad(id, r.runId)
          : d.mem.readOut(id, r.runId)
      const saved = d.mem.save(id, `${rc.prompt_sha256}.${rc.epoch}`, {
        result: { ds: res.ds, ok: res.status === 'ok', summary: summaryOf(res.status, res.report, o.command === true) },
        ...(notepad !== null ? { notepad: notepad.slice(0, NOTEPAD_INPUT_CHARS) } : {}),
      })
      if (saved.ok) kept++
    }
    d.mem.clearRun(id, r.runId)
  }
  return kept
}
