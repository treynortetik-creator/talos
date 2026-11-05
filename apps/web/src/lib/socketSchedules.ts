// The socket SchedulesClient (docs/SCHEDULES.md S2.2, S5). Every call is one signed owner frame sent with the same
// ack-or-error wait as card.resolve; none is queued (they need the Mac now). `schedules.list` and `schedule.get` are
// answered with a frame routed to this socket by `request_id`, so those wait for that frame too. A nonsense or newer
// snapshot is "update the app", a bridge without `schedules/1` is "update Talos on your Mac".
import {
  newUlid,
  parseScheduleSnapshot,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  type ScheduleChangeT,
  type ScheduleDetailT,
  type ScheduleSnapshotT,
} from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { SchedulesClient, SchedulesSlice } from './schedulesClient.ts'

export const NO_ANSWER_MS = 20_000

/** A patch the Mac has not acked within 20 s; its card may still arrive (`clientRef`). */
export class SlowPatch extends TalosClientError {
  readonly clientRef: string
  constructor(clientRef: string) {
    super('internal', 'no_answer')
    this.name = 'SlowPatch'
    this.clientRef = clientRef
  }
}

export type SocketSchedulesDeps = {
  /** Signs, sends and waits for `ack` or `error` (card.resolve's path). The frame may carry its own `id`. */
  sendAndWait(frame: Record<string, unknown>): Promise<unknown>
  /** Subscribe to a frame the relay routes back to this socket. */
  on(type: 'schedules.snapshot' | 'schedule.detail', cb: (f: Record<string, unknown>) => void): () => void
  getSlice(): SchedulesSlice
  setSlice(next: Partial<SchedulesSlice>): void
  /** The connected bridge's advertised features (`presence.features`), undefined when none were sent. */
  features(): string[] | undefined
  /** What the RELAY supports (`ready.features`). */
  relayFeatures?(): string[] | undefined
  macOnline(): boolean
  setTimeout?: typeof setTimeout
}

export function createSocketSchedules(d: SocketSchedulesDeps): SchedulesClient {
  const timer = d.setTimeout ?? setTimeout
  const fail = (error: string, code: ConstructorParameters<typeof TalosClientError>[0], message: string) => {
    d.setSlice({ status: 'error', error })
    return new TalosClientError(code, message)
  }
  /**
   * `app_features` is a field the bridge and relay from before schedules/2 do not know, and owner frames are strict objects, so
   * they turn the whole frame away. It goes only when BOTH the bridge and the relay list schedules/2; otherwise the frame is the
   * old one, byte for byte.
   */
  const readsField = (): Record<string, never> | { app_features: string[] } =>
    d.features()?.includes(SCHEDULES_FEATURE_V2) && d.relayFeatures?.()?.includes(SCHEDULES_FEATURE_V2)
      ? { app_features: [SCHEDULES_FEATURE_V2] }
      : {}
  const gate = () => {
    if (!d.macOnline()) throw new TalosClientError('mac_offline', 'Your Mac is offline.')
    const f = d.features()
    if (!f?.includes(SCHEDULES_FEATURE)) throw fail('update_mac', 'scheduler_unavailable', 'Update Talos on your Mac.')
  }

  /** `sendAndWait`, with the relay's silence reported as the Mac's: "Your Mac didn't answer". */
  const wait = async (frame: Record<string, unknown>) => {
    try {
      await d.sendAndWait(frame)
    } catch (e) {
      if (e instanceof TalosClientError && e.code === 'internal') throw new TalosClientError('internal', 'no_answer')
      throw e
    }
  }

  /** Sends `frame` and waits for the answer frame with the same request_id (and the ack). */
  async function ask<T>(
    type: 'schedules.snapshot' | 'schedule.detail',
    frame: Record<string, unknown>,
    pick: (f: Record<string, unknown>) => T,
  ): Promise<T> {
    const reqId = String(frame.request_id)
    let off: () => void = () => {}
    let timeout: ReturnType<typeof setTimeout> | undefined
    const answer = new Promise<T>((resolve, reject) => {
      off = d.on(type, (f) => {
        if (f.request_id !== reqId) return
        try {
          resolve(pick(f))
        } catch (e) {
          reject(e)
        }
      })
      timeout = timer(() => reject(fail('no_answer', 'internal', 'no_answer')), NO_ANSWER_MS)
    })
    try {
      const sent = wait(frame).catch((e: unknown) => {
        // The relay never answered the signed frame at all: same words as a silent Mac.
        if (e instanceof TalosClientError && e.message === 'no_answer') throw fail('no_answer', 'internal', 'no_answer')
        throw e
      })
      const [out] = await Promise.all([answer, sent])
      return out
    } finally {
      off()
      if (timeout) clearTimeout(timeout)
    }
  }

  return {
    async listSchedules() {
      d.setSlice({ status: d.getSlice().snapshot ? 'ready' : 'loading' })
      gate()
      const snapshot = await ask(
        'schedules.snapshot',
        { type: 'schedules.list', request_id: newUlid(), ...readsField() },
        (f) => {
          const r = parseScheduleSnapshot(f.snapshot)
          if (!r.ok) throw fail(r.reason === 'update_app' ? 'update_app' : 'invalid', 'internal', r.message)
          return r.snapshot
        },
      )
      d.setSlice({
        snapshot,
        status: 'ready',
        error: null,
        revs: Object.fromEntries(snapshot.schedules.map((s) => [s.id, `${s.etag}|${s.state_rev}`])),
      })
      return snapshot as ScheduleSnapshotT
    },
    async getSchedule(id, runId) {
      gate()
      const out = await ask(
        'schedule.detail',
        {
          type: 'schedule.get',
          request_id: newUlid(),
          schedule_id: id,
          report_run_id: runId,
          ...readsField(),
        },
        (f) => ({
          detail: f.detail as ScheduleDetailT,
          report: (f.report as { text: string } | null)?.text ?? null,
        }),
      )
      d.setSlice({ details: { ...d.getSlice().details, [id]: out.detail } })
      return out
    },
    async proposeScheduleChange(change: ScheduleChangeT, threadId) {
      gate()
      const id = newUlid()
      try {
        await wait({ id, type: 'schedule.patch', change, thread_id: threadId })
      } catch (e) {
        // Slow, not failed: the card the Mac mints late still carries client_ref = this id, so the caller can keep watching
        if (e instanceof TalosClientError && e.message === 'no_answer') throw new SlowPatch(id)
        throw e
      }
      // the bridge answers with a card.create whose payload.client_ref is this frame's id
      return { clientRef: id }
    },
    async runScheduleNow(id, opts) {
      gate()
      await wait({ type: 'schedule.run_now', schedule_id: id, again: opts.again, where: opts.where })
    },
    async controlSchedule(action, id) {
      gate()
      await wait({ type: 'schedule.control', action, schedule_id: id })
    },
  }
}
