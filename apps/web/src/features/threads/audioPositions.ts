// Saved positions of the message audio player (audioPlayer.ts re-exports what the rest of the app reads): per media_id, newest 50.
// A convenience only: every storage call is guarded, and an in-memory copy keeps working when storage is blocked (private window).
export const MAX_SAVED = 50
/** A saved position this close to the end is not resumed: the clip is treated as heard. */
export const NEAR_END_S = 5
export const POSITIONS_KEY = 'talos.audio.pos'

/** The player's store bumps `rev` when a saved position changes, so rows showing one redraw. */
let changed: () => void = () => {}
export function onPositionsChanged(fn: () => void): void {
  changed = fn
}

type Saved = { t: number; at: number }
let positions: Map<string, Saved> | null = null

function loadPositions(): Map<string, Saved> {
  if (positions) return positions
  const m = new Map<string, Saved>()
  try {
    const raw = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '[]') as unknown
    if (Array.isArray(raw))
      for (const e of raw) {
        if (Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && Number.isFinite(e[2]))
          m.set(e[0], { t: e[1], at: e[2] })
      }
  } catch {
    /* blocked storage or a damaged value: start empty */
  }
  positions = m
  return m
}

function persistPositions(m: Map<string, Saved>): void {
  if (m.size > MAX_SAVED) {
    const oldest = [...m.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, m.size - MAX_SAVED)
    for (const [id] of oldest) m.delete(id)
  }
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([...m.entries()].map(([id, v]) => [id, v.t, v.at])))
  } catch {
    /* private window or blocked storage */
  }
}

export function savedPosition(mediaId: string): number {
  return loadPositions().get(mediaId)?.t ?? 0
}

export function storePosition(mediaId: string, t: number | null): void {
  const m = loadPositions()
  if (t === null) {
    if (!m.delete(mediaId)) return
  } else m.set(mediaId, { t, at: Date.now() })
  persistPositions(m)
  changed()
}

/** Sign-out (audit D21): the positions say what he listened to, so they go with the chats. */
export function clearSavedPositions(): void {
  positions = new Map()
  try {
    localStorage.removeItem(POSITIONS_KEY)
  } catch {
    /* ignore */
  }
  changed()
}

/** Where a clip starts: the saved spot, unless it is close to the end (then from the top). */
export function resumeAt(mediaId: string, durationS: number): number {
  const t = savedPosition(mediaId)
  if (!(t > 0)) return 0
  if (durationS > 0 && durationS - t < NEAR_END_S) return 0
  return t
}

/** Test only: forget the in-memory copy, so the next read comes from storage. */
export function __resetPositionsForTests(): void {
  positions = null
}
