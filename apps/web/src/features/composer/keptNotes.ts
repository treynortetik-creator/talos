// Voice notes that could not be saved on this device (or sent) yet. They live here, one store per client, not in the
// composer: leaving the thread, or a call replacing the composer, must not lose a recording or let go of the reload hold.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { holdCapture } from '../../lib/appUpdate.ts'
import type { TalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { uploadVoiceWithDeadline } from '../../lib/uploadDeadline.ts'
import type { Recording } from './recorder.ts'

export const canQueue = (c: TalosClient): c is SocketClient => 'queueVoiceNote' in c

export type Kept = { r: Recording; threadId: string; name: string }
export type KeptNotes = {
  readonly store: StoreApi<{ items: Kept[] }>
  /** Saves the recording on the device (sent directly when that fails and the phone is online); kept if neither works. */
  submit(u: Kept): Promise<void>
  /** Saves each kept recording of this thread again, in turn. One run at a time. */
  retry(threadId: string): Promise<void>
  /** Drops this thread's kept recordings (the owner confirmed). */
  discard(threadId: string): void
}

const stores = new WeakMap<TalosClient, KeptNotes>()

export function getKeptNotes(client: TalosClient): KeptNotes {
  let k = stores.get(client)
  if (!k) {
    k = createKeptNotes(client)
    stores.set(client, k)
  }
  return k
}

function createKeptNotes(client: TalosClient): KeptNotes {
  const store = createStore<{ items: Kept[] }>(() => ({ items: [] }))
  let hold: (() => void) | null = null
  let retrying = false
  /** Bumped by a sign-out: anything that began before it drops out silently (nothing comes back, nothing is sent). */
  let generation = 0
  const set = (items: Kept[]) => {
    store.setState({ items })
    if (items.length > 0 && !hold) hold = holdCapture()
    if (items.length === 0) {
      hold?.()
      hold = null
    }
  }
  const keep = (u: Kept) => {
    if (!store.getState().items.includes(u)) set([...store.getState().items, u])
  }
  /** Takes out exactly this recording (by identity). */
  const unkeep = (u: Kept) => set(store.getState().items.filter((k) => k !== u))
  // A sign-out that wipes the queue wipes these too: the next person to sign in on this device must not send them.
  const clear = () => {
    generation++
    set([])
  }
  if ('onQueueWiped' in client) (client as SocketClient).onQueueWiped(clear)

  const place = async (u: Kept): Promise<boolean> => {
    const meta = { name: u.name, durationMs: u.r.durationMs, waveform: u.r.waveform }
    if (canQueue(client)) {
      try {
        await client.queueVoiceNote({ threadId: u.threadId, blob: u.r.blob, ...meta })
        getPlatform().haptic('light')
        return true
      } catch {
        // nothing was kept: fall through
      }
    }
    if (navigator.onLine && client.store.getState().connection === 'online') {
      try {
        const att = await uploadVoiceWithDeadline(client, u.r.blob, meta)
        await client.sendVoiceNote({ threadId: u.threadId, attachment: { ...att, kind: 'voice_note' } })
        getPlatform().haptic('light')
        return true
      } catch {
        // still in memory
      }
    }
    return false
  }

  return {
    store,
    // Only the confirmed notes go. A save still running (another thread's, or a new one) is not touched: only a sign-out
    // drops those.
    discard: (threadId) => set(store.getState().items.filter((k) => k.threadId !== threadId)),
    async submit(u) {
      const release = holdCapture() // in memory until placed, even if the composer is gone by then
      const began = generation
      try {
        if (!(await place(u)) && generation === began) keep(u)
      } finally {
        release()
      }
    },
    async retry(threadId) {
      if (retrying) return
      retrying = true
      const release = holdCapture()
      try {
        for (const u of store.getState().items.filter((k) => k.threadId === threadId)) {
          if (!store.getState().items.includes(u)) continue // deleted or wiped while an earlier one was being saved
          if (await place(u)) unkeep(u)
        }
      } finally {
        release()
        retrying = false
      }
    },
  }
}
