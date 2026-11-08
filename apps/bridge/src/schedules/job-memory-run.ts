// The places the schedule service touches job memory, kept out of service.ts (docs/SCHEDULES.md "Job memory"): building a run's
// memory section, keeping what a run reports when it is done, what a card changes, and which jobs may have it at all.
import {
  heartbeatConfigFromMeta,
  type ScheduleCardBase,
  type ScheduleChangeT,
  type toChronosChange,
} from '@talos-app/protocol'
import { bindingOf, type JobMemory, NOTEPAD_MAX_BYTES } from './job-memory.ts'
import type { Sidecar } from './sidecar.ts'

/** What a notepad sent through a tool is cut to before it is even looked at (the stored cap is NOTEPAD_MAX_BYTES). */
export const NOTEPAD_INPUT_MAX_CHARS = 16 * 1024

const STALE = " (this job's memory changed while the run was going, so nothing was kept)"

/**
 * The memory section for a run of `id`, and what the run is bound to (the job text and the memory's epoch); null when the job has
 * memory off. The read can wipe a file bound to other text, which moves the epoch: the binding returned is the one AFTER that.
 */
export function memoryForRun(
  mem: JobMemory,
  sidecar: Sidecar,
  id: string,
  prompt: string,
): { block: string; binding: string; epoch: string } | null {
  if (!sidecar.memoryOf(id)) return null
  if (sidecar.memoryEpoch(id) === undefined) sidecar.bumpEpoch(id) // a switch from before epochs: give it one
  const first = sidecar.memoryEpoch(id)
  if (first === undefined) return null
  const block = mem.promptBlock(id, bindingOf(prompt, first))
  const epoch = sidecar.memoryEpoch(id) ?? first
  return { block, binding: bindingOf(prompt, epoch), epoch }
}

/**
 * Keeps what a finished run reported: its result, and the notepad when it sent one. Returns the words to add to the tool's
 * answer ('' when there is nothing to say, so a plain `recorded` stays plain). Only a run that was offered the memory section may
 * write, and only while the memory is still the one it was offered: the offer holds the epoch and the binding, and any wipe, an
 * edit of the text, a thread change, switching memory off and on, or deleting the job has moved the epoch since.
 */
export function rememberRun(
  mem: JobMemory,
  sidecar: Sidecar,
  a: { jobId: string; runId: string; ds: string; ok: boolean; summary: string; notepad?: string | undefined },
): string {
  const asked = a.notepad !== undefined
  if (!sidecar.memoryOf(a.jobId)) return asked ? ' (memory is off for this job, so the notepad was not kept)' : ''
  const offer = sidecar.offerByRun(a.runId)
  if (!offer?.memory_binding || !offer.memory_epoch)
    return asked ? ' (this run started without memory, so the notepad was not kept)' : ''
  if (offer.memory_epoch !== sidecar.memoryEpoch(a.jobId)) return STALE
  const saved = mem.save(a.jobId, offer.memory_binding, {
    result: { ds: a.ds, ok: a.ok, summary: a.summary },
    ...(asked ? { notepad: a.notepad as string } : {}),
  })
  if (!saved.ok) {
    if (saved.stale) return STALE
    return asked ? ' (the notepad could not be saved)' : ' (memory could not be saved)'
  }
  if (!asked) return ''
  return saved.truncated
    ? `. Notepad saved, but cut to ${NOTEPAD_MAX_BYTES / 1024} KB: the end was dropped`
    : '. Notepad saved'
}

/**
 * After a card is applied: the Talos-only fields (the result thread, the memory switch) go to the sidecar, and what the job
 * remembered is wiped when the change makes it stale: new job text, an adopted file, memory switched either way, a new or removed
 * job, or a different result thread (a notepad written for one thread's session must not reach another's). A new job's entry
 * REPLACES whatever the sidecar held for that id, so a leftover memory switch never carries over. Returns why each part could not
 * be saved ('' when it was), so the card can say which.
 */
export function applyTalosFields(
  mem: JobMemory,
  sidecar: Sidecar,
  id: string,
  change: ScheduleChangeT,
  split: ReturnType<typeof toChronosChange>,
): { thread: string; memory: string } {
  const out = { thread: '', memory: '' }
  const notLive = 'the bridge was not live'
  if (change.op === 'delete') {
    mem.wipe(id)
    sidecar.forgetJob(id)
    return out
  }
  if (change.op === 'create') {
    mem.wipe(id)
    const wants = split.memory?.set === true && split.memory.value
    if (!sidecar.createJob(id, split.threadId.set ? split.threadId.value : null, wants)) {
      out.thread = notLive
      if (wants) out.memory = notLive
    }
    return out
  }
  const threadMoved = split.threadId.set && split.threadId.value !== sidecar.threadOf(id)
  const edited = change.op === 'update' && (change.set.prompt !== undefined || change.set.memory !== undefined)
  if (change.op === 'adopt' || edited || threadMoved) mem.wipe(id)
  if (split.threadId.set && !sidecar.setThread(id, split.threadId.value)) out.thread = notLive
  if (split.memory?.set && sidecar.memoryOf(id) !== split.memory.value && !sidecar.setMemory(id, split.memory.value))
    out.memory = notLive
  return out
}

/**
 * Why this change may not switch memory on, or null. Memory is put into the prompt the bridge hands to a session, so a heartbeat
 * (a check the bridge runs itself) and a command job (no prompt) cannot have it. Judged on the job as it would be after the change.
 */
export function memoryProblem(change: ScheduleChangeT, base: ScheduleCardBase | null): string | null {
  if (change.op === 'delete' || change.op === 'adopt') return null
  const cur = base?.schedule
  const on = change.op === 'create' ? change.draft.memory === true : (change.set.memory ?? cur?.memory) === true
  if (!on) return null
  const meta = change.op === 'create' ? change.draft.meta : change.set.meta === undefined ? cur?.meta : change.set.meta
  if (heartbeatConfigFromMeta(meta) !== null)
    return 'A heartbeat job cannot have memory: its runs are checks the bridge makes itself, not session runs that could be shown it. Switch memory off first. Nothing was saved.'
  if (cur?.kind === 'command')
    return 'A command job cannot have memory: it runs a command, not a prompt in your session. Nothing was saved.'
  return null
}
