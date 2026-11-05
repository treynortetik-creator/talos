// What the agent is told after the owner edits threads from the app (docs/THREADS.md). Routing keys on thread ids, which
// never change, but the agent picks a thread by its name and topic, so a rename, a new thread or a new topic must reach
// it. Names and topics are owner-signed text; they are JSON-quoted so they read as values, never as instructions.
import type { ThreadT } from '@talos-app/protocol'

const q = (s: string) => JSON.stringify(s)

/** One line per change, or null when nothing the agent routes on changed (order, colour, icon and notify do not count). */
export function describeThreadChanges(before: readonly ThreadT[], after: readonly ThreadT[]): string | null {
  const old = new Map(before.map((t) => [t.id, t]))
  const lines: string[] = []
  for (const t of after) {
    const was = old.get(t.id)
    if (!was) {
      if (t.archived) continue
      lines.push(`- new thread ${t.id} ${q(t.name)}${t.topic ? `, topic ${q(t.topic)}` : ''}`)
      continue
    }
    if (was.name !== t.name) lines.push(`- ${t.id} renamed ${q(was.name)} -> ${q(t.name)}`)
    if ((was.topic ?? '') !== (t.topic ?? ''))
      lines.push(t.topic ? `- ${t.id} topic is now ${q(t.topic)}` : `- ${t.id} topic cleared`)
    if (!was.archived && t.archived) lines.push(`- ${t.id} archived by the owner: stop posting there`)
    if (was.archived && !t.archived) lines.push(`- ${t.id} restored`)
  }
  const ids = new Set(after.map((t) => t.id))
  for (const t of before) if (!ids.has(t.id)) lines.push(`- ${t.id} removed`)
  if (!lines.length) return null
  return [
    'The owner changed threads in the app (thread ids are unchanged; route by the new names and topics):',
    ...lines,
    'No reply needed. Call list_threads for the full list.',
  ].join('\n')
}

/** The default thread changed: proactive messages with no matching topic now land there. */
export function describeDefaultChange(before: string, after: string, threads: readonly ThreadT[]): string | null {
  if (before === after) return null
  const name = threads.find((t) => t.id === after)?.name ?? after
  return `The owner made ${after} ${q(name)} the default thread: messages that fit no topic go there now. No reply needed.`
}
