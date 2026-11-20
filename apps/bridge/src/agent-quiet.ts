// The strict "did anything outside reach the agent since the owner last spoke" check, one rule for every agent session (the
// `talos-app` commands the agent runs, and the thread-setup changes the bridge makes on its say-so: config-propose/setup-gate.ts).
import type { HistoryStore } from './history-store.ts'
import { readTaint } from './peer/taint.ts'
import { isShareOnly } from './share-only.ts'
import { outsideTextAt } from './trust.ts'
import { anyLeadSpokeSince } from './worker/handoff.ts'

/** kv key: the device the owner's most recent message came from, `{device_id, at}` (inbound-messages.ts `noteOwnerDevice`). */
export const LAST_OWNER_DEVICE_KEY = 'last_owner_device'
/** kv key prefix: when the bridge received the owner's latest message in a thread (ms), for a thread session's own dating. */
export const OWNER_AT_PREFIX = 'last_owner_at:'

const OUTSIDE_WHY =
  'outside text (a message from a linked agent, a hook, a shared page) or a hand-off from another session reached the agent since the owner last spoke, so it is not run for the agent now. The owner can ask again in his own words, or run it in a terminal.'

/**
 * The strict check, with `scope` = the thread session that is asking when the bridge PROVED who it is (the hub's connection): since
 * the owner's latest words IN THAT THREAD, nothing outside may have reached ANY thread (a sub-thread's included), no lead may have
 * handed main anything and the peer taint must be empty. With no scope it is Main's rule: since his latest words in ANY thread (a share
 * is not him speaking). With no record of him speaking, anything outside refuses. See `outsideRefusalForCli` for the CLI, which can't
 * prove who calls.
 */
export function outsideRefusal(store: HistoryStore, now: number, scope?: string): string | undefined {
  // a thread session is dated from the owner's latest words in ITS OWN thread: outside text that reached it before he spoke elsewhere
  // is still what it may be working on. Main (no scope) keeps "his latest words anywhere".
  const spoke = scope === undefined ? ownerWordsAt(store, now) : ownerWordsInThread(store, scope, now)
  // every thread that ever got outside text has a kv key, whether or not the thread is still in config.json
  const threads = store.kvKeys(OUTSIDE_PREFIX).map((k) => k.slice(OUTSIDE_PREFIX.length))
  for (const t of threads) {
    const at = outsideTextAt({ store }, t)
    if (at !== undefined && at >= spoke) return OUTSIDE_WHY
  }
  // a hand-off query that errors refuses (fails closed); a table that is not there yet is simply no hand-off
  if (anyLeadSpokeSince(store.db, spoke, now, true)) return OUTSIDE_WHY
  if (readTaint({ store }))
    return 'a message from a linked agent may still be what the main session is working on, so it is not run for the agent now. The owner can ask again in his own words, or run it in a terminal.'
  return undefined
}

const OUTSIDE_PREFIX = 'outside_text_at:'

/**
 * When the owner last spoke, on the bridge's own clock. What is used, exactly: the time the bridge RECEIVED his latest message
 * (kv `last_owner_device`.at, written by `noteOwnerDevice` for every signed message that is not a share), never the time the phone
 * put on it, so a phone clock that runs fast cannot hide outside text that arrived after his words. A bridge that has not yet
 * received a message since this was added has no such time: then the newest non-share owner row's own time is used, never later than
 * now (a row from a fast phone is clamped to now, which can still be too late for that one message). 0 when he never spoke.
 */
function ownerWordsAt(store: HistoryStore, now: number): number {
  try {
    const at = (JSON.parse(store.kvGet(LAST_OWNER_DEVICE_KEY) ?? 'null') as { at?: unknown } | null)?.at
    if (typeof at === 'number' && Number.isFinite(at)) return at
  } catch {
    // unreadable: fall back to the rows
  }
  for (const m of store.ownerRowsSince(new Date(0).toISOString(), 500)) {
    if (isShareOnly(m)) continue
    return Math.min(Date.parse(m.created_at), now) // newest first: the first one that counts
  }
  return 0
}

/** When the owner last spoke in `thread` (a share is not him speaking), never later than now; 0 when he never did. */
function ownerWordsInThread(store: HistoryStore, thread: string, now: number): number {
  // the time the BRIDGE received his latest message in this thread (inbound-messages.ts noteOwnerDevice), never the phone's clock
  const got = Number(store.kvGet(`${OWNER_AT_PREFIX}${thread}`))
  if (store.kvGet(`${OWNER_AT_PREFIX}${thread}`) !== undefined && Number.isFinite(got)) return Math.min(got, now)
  for (const m of store.ownerRowsSince(new Date(0).toISOString(), 500)) {
    if (m.thread_id !== thread || isShareOnly(m)) continue
    return Math.min(Date.parse(m.created_at), now)
  }
  return 0
}

/**
 * The `talos-app` commands the agent runs: the caller's label (env variables, the `.talos-lead` marker) is the session's own and
 * proves nothing, so the rule can't depend on it. Refused when Main's rule refuses (outside text in any thread since his latest words
 * anywhere, a lead spoke, the peer taint), OR when a thread that has a session (dedicated and not archived in the config, or still running by workers.json) had outside text at or
 * after his latest words in THAT thread: only such a session can call with a taint Main's rule misses, so threads Main serves add
 * nothing. The refusal names that thread by its id. `sessions` is 'all' when the status could not be read (fail closed).
 */
export function outsideRefusalForCli(
  store: HistoryStore,
  now: number,
  sessions: ReadonlyArray<string> | 'all',
): string | undefined {
  const main = outsideRefusal(store, now)
  if (main) return main
  const ids =
    sessions === 'all'
      ? store.kvKeys(OUTSIDE_PREFIX).map((k) => k.slice(OUTSIDE_PREFIX.length))
      : [...new Set(sessions)]
  for (const id of ids) {
    const at = outsideTextAt({ store }, id)
    // the thread id (validated), never its name: a name is only length-checked and this text is read by the agent
    if (at !== undefined && at >= ownerWordsInThread(store, id, now))
      return `outside text reached thread ${id} since you last spoke there, so it is not run for the agent now. Say so in that thread, or run it in a terminal.`
  }
  return undefined
}
