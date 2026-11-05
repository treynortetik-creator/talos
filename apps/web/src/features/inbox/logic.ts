// Inbox logic (spec 8.2 `/t/inbox`). Pure, so the plain-text and link rules are unit-testable.
import { HttpsUrl, type InboxItemT, localMinutes, type QuietWindow } from '@talos-app/protocol'

export type InboxTab = 'priority' | 'other'

export const isPriority = (i: InboxItemT): boolean => i.priority !== 'low'

/** Items that still need a decision: not done, not snoozed. */
export const isOpen = (i: InboxItemT): boolean => i.state === 'new' || i.state === 'read'

export function tabItems(items: InboxItemT[], tab: InboxTab): InboxItemT[] {
  return items
    .filter(isOpen)
    .filter((i) => (tab === 'priority' ? isPriority(i) : !isPriority(i)))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
}

export function tabCounts(items: InboxItemT[]): Record<InboxTab, number> {
  const open = items.filter(isOpen)
  return { priority: open.filter(isPriority).length, other: open.filter((i) => !isPriority(i)).length }
}

/** `href` only for http(s) URLs that pass the protocol's `HttpsUrl`; anything else (javascript:, data:) is dropped. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null
  const r = HttpsUrl.safeParse(url)
  return r.success ? r.data : null
}

/** One snooze option in v1: until the quiet window ends, or 08:00 without one (in the agent's timezone). */
export function snoozeUntil(now: Date, tz: string, quiet: QuietWindow): Date {
  const target = quiet?.end ?? '08:00'
  const [h, m] = target.split(':').map(Number) as [number, number]
  const want = h * 60 + m
  const step = 60_000
  let t = Math.floor(now.getTime() / step) * step + step
  for (let i = 0; i < 48 * 60; i++, t += step) {
    if (localMinutes(new Date(t), tz) === want) return new Date(t)
  }
  return new Date(now.getTime() + 12 * 3600 * 1000)
}

export const TRUNCATED_NOTICE = 'Some mail was skipped: more than 200 messages arrived at once.'

export const unreadableNotice = (n: number) =>
  n === 1 ? '1 item could not be read and is left out.' : `${n} items could not be read and are left out.`
