// The one plain row a heartbeat run posts (docs/HEARTBEAT.md). Pure: items in, text out. Item titles were escaped when the
// source answer was parsed (`visibleMetaText`), so what is printed here is what is stored. No markdown: a title cannot
// become formatting, and the row is `format: 'plain'` anyway.
import type { StoredItem } from './store.ts'

/** The watcher's cap, kept: a digest is read at a glance. */
export const DIGEST_MAX_WORDS = 72
export const ACT_LINES_MAX = 8

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

export type DigestInput = {
  /** fyi items, and act items that rolled into the digest at the wake cap. */
  fyi: StoredItem[]
  /** act items nobody woke the agent for: listed as lines that ask the owner to reply. */
  needYou: StoredItem[]
  /** Work-class items refused this run, counted by source (never their text). */
  refused: Record<string, number>
  /** Sources that failed (3rd miss in a row, or every source failed): id and an already-escaped error. */
  failures: Array<{ id: string; error: string; streak: number }>
  /** The run itself failed: every source did, or no source was on. */
  failedRun: string | null
  notes: string[]
}

export type Digest = {
  text: string
  /** True: no push. Only a plain fyi digest is silent. */
  silent: boolean
  /** Items this row actually lists (the ones that may be marked surfaced). */
  listed: StoredItem[]
}

export function composeDigest(i: DigestInput): Digest | null {
  const parts: string[] = []
  const listed: StoredItem[] = []
  if (i.failedRun) parts.push(i.failedRun)
  if (i.needYou.length) {
    const shown = i.needYou.slice(0, ACT_LINES_MAX)
    parts.push(['Needs you:', ...shown.map((t) => `- ${t.title}`)].join('\n'))
    if (i.needYou.length > shown.length) parts.push(`+${i.needYou.length - shown.length} more waiting`)
    parts.push("Reply here and I'll take it.")
    listed.push(...shown)
  }
  if (i.fyi.length) {
    const lines: string[] = []
    let used = 0
    for (const t of i.fyi) {
      const w = words(t.title)
      if (lines.length > 0 && used + w > DIGEST_MAX_WORDS) break
      lines.push(`- ${t.title}`)
      used += w
    }
    const more = i.fyi.length - lines.length
    parts.push([`Heartbeat: ${i.fyi.length} ${i.fyi.length === 1 ? 'update' : 'updates'}`, ...lines].join('\n'))
    if (more > 0) parts.push(`+${more} more`)
    listed.push(...i.fyi.slice(0, lines.length)) // the ones behind "+N more" stay new and lead the next digest
  }
  for (const [source, n] of Object.entries(i.refused))
    parts.push(
      `${n} work ${n === 1 ? 'item' : 'items'} from ${source} ${n === 1 ? 'was' : 'were'} not shown: work content is turned off for Heartbeat.`,
    )
  for (const f of i.failures)
    parts.push(
      f.streak >= 3 ? `${f.id} has failed ${f.streak} checks in a row: ${f.error}` : `${f.id} failed: ${f.error}`,
    )
  parts.push(...i.notes)
  if (!parts.length) return null
  const text = parts.join('\n').slice(0, 3900)
  return { text, silent: !i.needYou.length && !i.failedRun, listed }
}
