import type { ThreadT } from '@talos-app/protocol'
import { THREADS_FEATURE } from '@talos-app/protocol'
import { useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../../lib/client.ts'
import { useFeature } from '../../../lib/v2Client.ts'
import { renumber } from '../../agent-config/patch.ts'

/** Threads in sidebar order (stable: equal `order` keeps file order). */
export function sortThreads(threads: readonly ThreadT[]): ThreadT[] {
  return threads.slice().sort((a, b) => a.order - b.order)
}

/**
 * The full thread list after the owner reordered `ids` (the threads shown in the reorder list). Those threads take the
 * slots they held between them in the new order; everything else (the inbox, archived threads) stays exactly where it
 * was. `order` is renumbered to match.
 */
export function reorderThreads(threads: readonly ThreadT[], ids: readonly string[]): ThreadT[] {
  const sorted = sortThreads(threads)
  const moved = new Set(ids)
  const queue = ids.map((id) => sorted.find((t) => t.id === id)).filter((t): t is ThreadT => t !== undefined)
  let i = 0
  return renumber(sorted.map((t) => (moved.has(t.id) ? (queue[i++] ?? t) : t)))
}

const RICH_KEYS = ['icon', 'color', 'topic'] as const

/**
 * What goes on the wire. The bridge keeps any key a thread leaves out (so an older app can't wipe color or topic), so
 * a Mac that knows those fields (`threads/2`) is sent `null` for each one the owner cleared.
 */
export function wireThreads(threads: readonly ThreadT[], rich: boolean): Array<Record<string, unknown>> {
  return renumber(sortThreads(threads)).map((t) => {
    const out: Record<string, unknown> = { ...t }
    if (rich) for (const k of RICH_KEYS) if (out[k] === undefined) out[k] = null
    return out
  })
}

/**
 * A saved-patch error as a sentence (shared with every setting that saves at once). The Mac's own refusal text (a folder
 * that is not there, a limit out of range, a thread that may not have its own session) is passed on in words, never
 * swallowed into "couldn't save".
 */
export function friendlyPatchError(e: unknown, what: 'settings' | 'threads' = 'settings'): string {
  if (!(e instanceof TalosClientError)) return e instanceof Error && e.message ? e.message : 'Could not change that.'
  const said = e.message && e.message !== e.code ? e.message : ''
  switch (e.code) {
    case 'config_conflict':
      return what === 'threads'
        ? 'Something else changed the threads at the same time. Your list is up to date now; try again.'
        : 'Something else changed these settings at the same time. They are up to date now; try again.'
    case 'thread_session_refused':
      return said ? `Your Mac said no: ${said}` : 'Your Mac said no to that thread session setting.'
    case 'config_field_forbidden':
      return "That setting can't be changed from the app."
    case 'bad_frame':
      return said ? `Your Mac didn't accept that: ${said}` : "Your Mac didn't accept that value."
    case 'mac_offline':
      return said || "Your Mac is offline. Try again when it's back."
    default:
      return said || 'Could not change that.'
  }
}

/**
 * Saves thread edits through the owner-signed `config.patch` (the same path Settings uses; the relay cannot forge it).
 * Resolves true only once the Mac applied it. `rich` is true when the Mac keeps icon, color and topic (`threads/2`).
 * `apply` builds the new list from the LATEST threads in the store, never from a render's stale copy.
 */
export function useThreadPatch() {
  const client = useTalosClient()
  const threads = useTalos((s) => s.threads)
  const defaultThread = useTalos((s) => s.config?.default_thread ?? 'inbox')
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const rich = useFeature(THREADS_FEATURE) === 'on'
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const apply = async (
    next: (latest: ThreadT[]) => ThreadT[],
    extra: Record<string, unknown> | (() => Record<string, unknown>) = {},
  ): Promise<boolean> => {
    setErr(null)
    setBusy(true)
    try {
      const latest = sortThreads(client.store.getState().threads)
      const threads = wireThreads(next(latest), rich)
      await client.patchConfig({ threads, ...(typeof extra === 'function' ? extra() : extra) })
      return true
    } catch (e) {
      setErr(friendlyPatchError(e, 'threads'))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { threads, defaultThread, macOnline, rich, err, busy, apply, setErr }
}
