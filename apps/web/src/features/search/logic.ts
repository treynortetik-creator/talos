// Search UI logic that needs no React (docs/V2-FEATURES.md V3.3).
import { foldForSearch, type MessageT, type SearchFiltersT, type SearchHitT } from '@talos-app/protocol'

export const MIN_CHARS = 2
export const DEBOUNCE_MS = 300
export const RECENT_KEY = 'talos.search.recent'
export const RECENT_MAX = 10

export type Seg = { text: string; mark: boolean }

/**
 * The snippet cut at `marks` ([start,end) UTF-16 offsets into the plain snippet), as text segments. React renders each as a
 * text node, so a snippet that contains `<img onerror=…>` is shown as that text, never parsed. Bad offsets are clamped.
 */
export function segments(snippet: string, marks: ReadonlyArray<readonly [number, number]>): Seg[] {
  const out: Seg[] = []
  let at = 0
  const sorted = [...marks].sort((a, b) => a[0] - b[0])
  for (const [rawS, rawE] of sorted) {
    const s = Math.max(at, Math.min(snippet.length, rawS))
    const e = Math.max(s, Math.min(snippet.length, rawE))
    if (e === s) continue
    if (s > at) out.push({ text: snippet.slice(at, s), mark: false })
    out.push({ text: snippet.slice(s, e), mark: true })
    at = e
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), mark: false })
  return out
}

export type TimeRange = 'any' | 'day' | 'week' | 'month'
export const RANGE_LABEL: Record<TimeRange, string> = {
  any: 'Any time',
  day: 'Past 24 hours',
  week: 'Past week',
  month: 'Past month',
}
const RANGE_MS: Record<Exclude<TimeRange, 'any'>, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
}

export function filtersFor(
  s: { threadId: string; from: SearchFiltersT['from']; hasFile: boolean; range: TimeRange },
  nowMs: number,
): SearchFiltersT {
  return {
    thread_ids: s.threadId ? [s.threadId] : [],
    from: s.from,
    has_file: s.hasFile ? true : null,
    after: s.range === 'any' ? null : new Date(nowMs - RANGE_MS[s.range]).toISOString(),
    before: null,
  }
}

/**
 * The offline fallback (V3.2): a folded substring search over messages cached on this device. Every word must appear;
 * the newest match first. Marks are computed on the folded text, which has the same length for the Latin text this
 * handles, and are dropped when folding changed the length.
 */
export function searchCached(
  messages: Record<string, MessageT[]>,
  q: string,
  filters: SearchFiltersT,
  sort: 'relevance' | 'newest',
  limit = 50,
): SearchHitT[] {
  const terms = foldForSearch(q).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const after = filters.after ? Date.parse(filters.after) : null
  const rows: Array<{ m: MessageT; text: string; where: 'text' | 'transcript' | 'attachment_name' }> = []
  for (const list of Object.values(messages)) {
    for (const m of list) {
      if (filters.thread_ids.length && !filters.thread_ids.includes(m.thread_id)) continue
      if (filters.from === 'owner' && (m.author !== 'owner' || m.via === 'share')) continue // shares are not owner words
      if (filters.from === 'agent' && m.author === 'owner') continue
      if (after !== null && Date.parse(m.created_at) < after) continue
      if (filters.has_file && !m.attachments?.some((a) => a.role === 'attachment' && a.kind !== 'voice_note')) continue
      const candidates: Array<[string, 'text' | 'transcript' | 'attachment_name']> = [
        [m.text ?? '', 'text'],
        [m.transcript?.text ?? '', 'transcript'],
        [
          (m.attachments ?? [])
            .filter((a) => a.role !== 'voice_reply')
            .map((a) => a.name)
            .join('\n'),
          'attachment_name',
        ],
      ]
      for (const [text, where] of candidates) {
        const f = foldForSearch(text)
        if (text && terms.every((t) => f.includes(t))) {
          rows.push({ m, text, where })
          break
        }
      }
    }
  }
  rows.sort((a, b) => b.m.created_at.localeCompare(a.m.created_at))
  void sort // offline there is no relevance score: newest first either way
  return rows.slice(0, limit).map(({ m, text, where }) => {
    const folded = foldForSearch(text)
    const first = Math.max(0, Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0)))
    const start = Math.max(0, first - 60)
    const snippet = `${start > 0 ? '…' : ''}${text.slice(start, start + 240).replace(/\s/g, ' ')}`
    const lead = start > 0 ? 1 : 0
    const marks: Array<[number, number]> = []
    if (folded.length === text.length) {
      for (const t of terms) {
        for (
          let at = folded.indexOf(t, start);
          at >= 0 && at < start + 240 && marks.length < 20;
          at = folded.indexOf(t, at + t.length)
        )
          marks.push([at - start + lead, at - start + lead + t.length])
      }
    }
    return {
      message_id: m.id,
      thread_id: m.thread_id,
      seq: m.seq ?? null,
      author: m.author,
      kind: m.kind,
      via: m.via ?? 'app',
      created_at: m.created_at,
      match_in: where,
      snippet: snippet.slice(0, 320),
      marks: marks.sort((a, b) => a[0] - b[0]),
    }
  })
}

// ---- the last 10 queries per device (a per-viewer convenience: every access guarded) ------------------------------------

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function pushRecent(q: string): string[] {
  const t = q.trim()
  if (t.length < MIN_CHARS) return loadRecent()
  const next = [t, ...loadRecent().filter((x) => x !== t)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // private window or blocked storage: the list just doesn't persist
  }
  return next
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    // nothing stored
  }
}
