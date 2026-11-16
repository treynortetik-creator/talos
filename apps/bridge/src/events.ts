// Named moments in the bridge's life, for future hooks (the standing rule: a new lifecycle moment emits a named event).
// An event is one structured log line, `event` plus the names of what it is about, never the owner's words or paths, so a hook
// or a mod can later read the log or subscribe here without this code changing. The names live in the protocol.

import { parseArgs } from 'node:util'
import {
  type AgentConfigT,
  type ConfigEventSource,
  EVENTS,
  eventInfo,
  eventsList,
  SETTING_CHANGED_EVENT,
  SETTINGS_TABLE,
  THREAD_ARCHIVED_EVENT,
  THREAD_CREATED_EVENT,
  THREAD_FOLDER_CHOSEN_EVENT,
  THREAD_RENAMED_EVENT,
  THREAD_SETTING_EVENT_FIELDS,
  THREAD_UNARCHIVED_EVENT,
  type ThreadT,
} from '@talos-app/protocol'
import type { Logger } from './log.ts'

/**
 * Writes one `event` line, when `name` is registered (packages/protocol/src/events.ts) and `fields` parse against its payload.
 * Checked at run time as well as in tests, because the payload rule (ids and enums only, never a path or free text) is what lets a
 * hook runner trust an event later; the check is a small parse of a few fields, once per lifecycle moment. It never throws into
 * the caller: a refused event is dropped with a warning that names the event and the reason, never the values. Returns whether it wrote.
 */
export function emitEvent(
  log: Pick<Logger, 'info' | 'warn'>,
  name: string,
  fields: Record<string, unknown> = {},
): boolean {
  const info = eventInfo(name)
  if (!info) {
    log.warn('event dropped', { event: name, reason: 'not registered' })
    return false
  }
  if (!info.payload.safeParse(fields).success) {
    log.warn('event dropped', { event: name, reason: 'fields do not match the registered payload' })
    return false
  }
  log.info('event', { event: name, ...fields })
  return true
}

/** Threads whose own-session folder was set, changed or cleared by a saved change. */
export function chosenFolders(
  before: readonly ThreadT[],
  after: readonly ThreadT[],
): Array<{ thread_id: string; cleared: boolean }> {
  const was = new Map(before.map((t) => [t.id, t.session_opts?.cwd]))
  const out: Array<{ thread_id: string; cleared: boolean }> = []
  for (const t of after) {
    if (!was.has(t.id) && t.session_opts?.cwd === undefined) continue
    const cwd = t.session_opts?.cwd
    if (cwd !== was.get(t.id)) out.push({ thread_id: t.id, cleared: cwd === undefined })
  }
  return out
}

/** `thread.folder_chosen`: the owner set, changed or cleared a thread's folder. Carries the thread id, not the path. */
export function emitFolderEvents(
  log: Pick<Logger, 'info' | 'warn'>,
  before: readonly ThreadT[],
  after: readonly ThreadT[],
): void {
  for (const c of chosenFolders(before, after)) emitEvent(log, THREAD_FOLDER_CHOSEN_EVENT, c)
}

const valueAt = (c: AgentConfigT, path: string): unknown => {
  const [top, sub] = path.split('.') as [string, string | undefined]
  const v = (c as unknown as Record<string, unknown>)[top]
  return sub === undefined ? v : (v as Record<string, unknown> | undefined)?.[sub]
}

/**
 * `thread.created`, `thread.renamed`, `thread.archived`, `thread.unarchived` and `setting.changed`, from what a saved change did: the owner's patch
 * from the app, or an agent proposal (approved on a card, or applied directly in trust mode). Ids and setting names only, never a
 * name, a topic or a value. A thread's topic, icon, alerts and own session are `setting.changed` with `threads.<field>`.
 */
export function emitConfigEvents(
  log: Pick<Logger, 'info' | 'warn'>,
  before: AgentConfigT,
  after: AgentConfigT,
  source: ConfigEventSource,
): void {
  const was = new Map(before.threads.map((t) => [t.id, t]))
  for (const t of after.threads) {
    const w = was.get(t.id)
    if (!w) {
      emitEvent(log, THREAD_CREATED_EVENT, { thread_id: t.id, source })
      continue
    }
    if (w.name !== t.name) emitEvent(log, THREAD_RENAMED_EVENT, { thread_id: t.id, source })
    if (!w.archived && t.archived) emitEvent(log, THREAD_ARCHIVED_EVENT, { thread_id: t.id, source })
    if (w.archived && !t.archived) emitEvent(log, THREAD_UNARCHIVED_EVENT, { thread_id: t.id, source })
    for (const f of THREAD_SETTING_EVENT_FIELDS)
      if ((w[f] ?? null) !== (t[f] ?? null))
        emitEvent(log, SETTING_CHANGED_EVENT, { setting: `threads.${f}`, thread_id: t.id, source })
  }
  for (const path of Object.keys(SETTINGS_TABLE)) {
    if (path === 'threads') continue
    if (JSON.stringify(valueAt(before, path)) !== JSON.stringify(valueAt(after, path)))
      emitEvent(log, SETTING_CHANGED_EVENT, { setting: path, source })
  }
}

/** `talos events [--json]`: the registry, so an agent reads which events exist instead of guessing. Read-only. Returns the exit code. */
export function cmdEvents(args: string[], io: { out(line: string): void }): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  if (values.json) {
    io.out(JSON.stringify(eventsList(), null, 2))
    return 0
  }
  const width = Math.max(...EVENTS.map((e) => e.name.length))
  for (const e of eventsList().events)
    io.out(`${e.name.padEnd(width)}  ${e.emitter.padEnd(6)}  ${e.status.padEnd(7)}  ${e.fields.join(', ')}`)
  return 0
}
