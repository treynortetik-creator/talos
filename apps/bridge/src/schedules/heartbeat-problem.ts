// Does a schedule change leave a valid heartbeat? Checked before any card exists (docs/HEARTBEAT.md).
import {
  heartbeatConfigFromMeta,
  heartbeatMetaProblem,
  type ScheduleCardBase,
  type ScheduleChangeT,
} from '@talos-app/protocol'

/** The meta and `when` the job will have after `change`, checked as a heartbeat (`heartbeatMetaProblem`). */
export function heartbeatProblemOf(
  change: ScheduleChangeT,
  base: ScheduleCardBase | null,
  defaultThread: string,
): string | null {
  const p = heartbeatProblemBase(change, base)
  if (p) return p
  if (change.op === 'delete') return null
  const cur = base?.schedule
  // The thread the job will have after the change: a heartbeat has to have one of its own, because the card limits key on it.
  const meta =
    change.op === 'create'
      ? change.draft.meta
      : change.op === 'update' && change.set.meta !== undefined
        ? change.set.meta
        : cur?.meta
  if (!heartbeatConfigFromMeta(meta)) return null
  if (change.op === 'update' && Object.entries(change.set).every(([k, v]) => k === 'enabled' && v === false))
    return null
  const thread =
    change.op === 'create'
      ? change.draft.thread_id
      : change.op === 'update' && change.set.thread_id !== undefined
        ? change.set.thread_id
        : (cur?.thread_id ?? null)
  if (thread === null || thread === defaultThread)
    return 'A heartbeat needs its own thread: its cards are limited by the thread they are made in. Give it a thread of its own (not the default one). Nothing was saved.'
  return null
}

function heartbeatProblemBase(change: ScheduleChangeT, base: ScheduleCardBase | null): string | null {
  if (change.op === 'delete') return null
  if (change.op === 'create')
    return heartbeatProblem(
      change.draft.meta,
      change.draft.when,
      change.draft.runner,
      change.draft.permissions,
      'claude',
    )
  const cur = base?.schedule
  // Switching a job off, or moving its result thread, never starts anything: a heartbeat that is already headless or restricted
  // must stay switch-off-able. Anything that keeps it enabled is judged in full.
  if (
    change.op === 'update' &&
    Object.entries(change.set).every(([k, v]) => k === 'thread_id' || (k === 'enabled' && v === false))
  )
    return null
  if (change.op === 'adopt') return heartbeatProblem(cur?.meta, cur?.when, cur?.runner, cur?.permissions, cur?.kind)
  const meta = change.set.meta === undefined ? cur?.meta : change.set.meta
  return heartbeatProblem(
    meta,
    change.set.when ?? cur?.when,
    change.set.runner ?? cur?.runner,
    change.set.permissions ?? cur?.permissions,
    cur?.kind,
  )
}

/**
 * The contract's check (`heartbeatMetaProblem`), plus one rule of the runner: a heartbeat is checked by THIS bridge, in the
 * live session. A job that runs headless, is restricted (always headless) or is a command would be started by Chronos with the
 * job's prompt: an agent run on every slot, which is what a heartbeat is there to avoid. Refused before any card exists.
 */
function heartbeatProblem(
  meta: unknown,
  when: { type?: string } | null | undefined,
  runner: string | undefined,
  permissions: string | undefined,
  kind: string | undefined,
): string | null {
  const p = heartbeatMetaProblem(meta, when)
  if (p) return p
  if (!heartbeatConfigFromMeta(meta)) return null
  if (runner !== 'session' || permissions === 'restricted' || kind === 'command')
    return 'A heartbeat has to run in the live session (runner "session", full permissions, a Claude job): any other kind would start the agent in the background on every slot. Nothing was saved.'
  return null
}
