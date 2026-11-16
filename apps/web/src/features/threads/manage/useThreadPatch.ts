import type { ThreadT } from '@talos-app/protocol'
import { jcs, THREADS_FEATURE } from '@talos-app/protocol'
import { useState } from 'react'
import { NoAnswerError, NotSentError, TalosClientError, useTalos, useTalosClient } from '../../../lib/client.ts'
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

const same = (a: unknown, b: unknown) => a === b || (a !== undefined && b !== undefined && jcs(a) === jcs(b))

/** The keys of `next` that differ from `was`; `session_opts` one level down, so a setting the owner left alone stays out. */
function changedKeys(next: ThreadT, was: ThreadT, rich: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (k === 'id' || k === 'order' || v === undefined || same(v, was[k as keyof ThreadT])) continue
    if (k === 'session_opts' && was.session_opts) {
      const opts: Record<string, unknown> = {}
      for (const [o, ov] of Object.entries(v as Record<string, unknown>))
        if (!same(ov, (was.session_opts as Record<string, unknown>)[o])) opts[o] = ov
      for (const o of Object.keys(was.session_opts)) if ((v as Record<string, unknown>)[o] === undefined) opts[o] = null
      out.session_opts = opts
    } else out[k] = v
  }
  if (rich) for (const k of RICH_KEYS) if (next[k] === undefined && was[k] !== undefined) out[k] = null
  return out
}

/**
 * What goes on the wire (protocol audit O4). The Mac keeps any key a thread leaves out, so a thread it already has is sent
 * as its id, its place and only what the owner changed against `base` (the list this app read). Echoing the rest would
 * send back a fallback this build read for a value it does not understand (an `idle_park_min` past its range, a
 * `session_opts` it cannot read) over the Mac's real one. A new thread goes whole. A Mac that knows icon, color and topic
 * (`threads/2`) is sent `null` for each one the owner cleared.
 */
export function wireThreads(
  threads: readonly ThreadT[],
  rich: boolean,
  opts: {
    /** The threads as this app read them, before this save's edits. */
    base: readonly ThreadT[]
    /** Threads taken out from under their parent by this save: the bridge keeps a key left out, so the clear is said (null). */
    clearParent?: ReadonlySet<string>
  },
): Array<Record<string, unknown>> {
  const before = new Map(opts.base.map((t) => [t.id, t]))
  return renumber(sortThreads(threads)).map((t) => {
    const was = before.get(t.id)
    const out: Record<string, unknown> = was
      ? { id: t.id, order: t.order, ...changedKeys(t, was, rich) }
      : Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined))
    if (!was && rich) for (const k of RICH_KEYS) if (out[k] === undefined) out[k] = null
    // named by the save, never inferred: a parent_id the schema could not read is also undefined here, and must be kept
    if (opts.clearParent?.has(t.id)) out.parent_id = null
    return out
  })
}

/**
 * A saved-patch error as a sentence (shared with every setting that saves at once). The Mac's own refusal text (a folder
 * that is not there, a limit out of range, a thread that may not have its own session) is passed on in words, never
 * swallowed into "couldn't save".
 */
/** A change refused before it left this device (offline): nothing was sent, so nothing changed. */
export const OFFLINE_NOT_CHANGED = 'Not changed: you’re offline. Try again once you’re connected.'

/** The connection dropped after the change was sent and before the Mac answered: it may or may not have applied. */
export const DROPPED_MAYBE_CHANGED =
  'The connection dropped before your Mac answered, so this may not have changed. Check it once you’re connected.'

/** What the socket rejects a waiting request with when it closes (socket-connection, socket-lifecycle, socket-client-session). */
const DROPPED = new Set(['Connection lost', 'Offline', 'Closed'])

/**
 * The whole sentence for a change this device's connection stopped (not sent, or its answer lost), else null. It is the
 * entire message: a caller's own "Not saved." would be wrong for a change that may have applied.
 */
export function connectionRefusal(e: unknown): string | null {
  if (e instanceof NotSentError && e.code === 'internal') return OFFLINE_NOT_CHANGED
  if (e instanceof NoAnswerError && e.code === 'internal' && DROPPED.has(e.message)) return DROPPED_MAYBE_CHANGED
  return null
}

/**
 * The same sentence for a session control's stored outcome (session/store.ts keeps the raw text for the composer, which
 * puts a typed command back in the box): not sent ('local'), or its answer lost to a dropped connection.
 */
export function connectionRefusalOf(o: { code?: string; local?: boolean; text: string }): string | null {
  if (o.code !== 'internal') return null
  if (o.local) return OFFLINE_NOT_CHANGED
  return DROPPED.has(o.text) ? DROPPED_MAYBE_CHANGED : null
}

export function friendlyPatchError(e: unknown, what: 'settings' | 'threads' = 'settings'): string {
  if (!(e instanceof TalosClientError)) return e instanceof Error && e.message ? e.message : 'Could not change that.'
  const conn = connectionRefusal(e)
  if (conn) return conn
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
    opts: { clearParent?: ReadonlySet<string> } = {},
  ): Promise<boolean> => {
    setErr(null)
    setBusy(true)
    try {
      const latest = sortThreads(client.store.getState().threads)
      const threads = wireThreads(next(latest), rich, { base: latest, clearParent: opts.clearParent })
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
