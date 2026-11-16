// Keeps what the schema did not read (docs: standing rule 1, the owner's changes are never overwritten). A strict parse
// strips keys it does not know and `.catch()` replaces a value it cannot read, so serializing the parsed config alone loses
// both. The one mechanism: compare the raw file with its own parse (`lossesOf`), and when a config is written put those
// losses back (`restoreLosses`) where this write did not touch them. Works for any schema, at any depth.

import { isDeepStrictEqual } from 'node:util'

/** A step down: an object key, or an array element found by its string `id`. */
type Step = string | { id: string }
export type Loss =
  /** The parse dropped this key. Put back when the written config has no such key. */
  | { path: Step[]; kind: 'dropped'; raw: unknown }
  /** The parse changed this value (`.catch`, a lenient transform). Put back when the write left the read value as it was. */
  | { path: Step[]; kind: 'altered'; raw: unknown; read: unknown }
  /** The parse kept only some items of a list of plain values (a newer peer's id). Written back with the new list, in raw order. */
  | { path: Step[]; kind: 'extras'; raw: unknown[]; read: unknown[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const idOf = (v: unknown) => (isObj(v) && typeof v.id === 'string' ? v.id : undefined)
const has = (list: unknown[], item: unknown) => list.some((x) => isDeepStrictEqual(x, item))

/** An array of objects that all carry a string `id`, each one once: the only kind matched element by element. */
function byUniqueId(a: unknown[]): boolean {
  if (!a.every(isObj)) return false
  const ids = a.map(idOf)
  return ids.every((x) => x !== undefined) && new Set(ids).size === ids.length
}

/** Lists the schema filters item by item (it drops ids it does not know), so an empty read still means "all dropped". */
const FILTERED_LISTS = ['work.enabled']

/** Everything in `raw` that `read` (the parse of `raw`) lost or changed. */
export function lossesOf(raw: unknown, read: unknown, path: Step[] = []): Loss[] {
  if (isObj(raw) && isObj(read)) {
    return Object.keys(raw).flatMap((k) =>
      read[k] !== undefined
        ? lossesOf(raw[k], read[k], [...path, k])
        : [{ path: [...path, k], kind: 'dropped', raw: raw[k] } as Loss],
    )
  }
  if (Array.isArray(raw) && Array.isArray(read)) {
    if (byUniqueId(raw) && byUniqueId(read)) {
      return raw.flatMap((el) => {
        const id = idOf(el) as string
        const twin = read.find((r) => idOf(r) === id)
        return twin === undefined ? [] : lossesOf(el, twin, [...path, { id }])
      })
    }
    // a list of plain values the parse filtered (`work.enabled`): the items it dropped are kept. Elsewhere an empty read is a
    // fallback for a list it could not read at all (invalid as a whole), not a filter, so it is one value
    if (
      (read.length > 0 || FILTERED_LISTS.includes(path.join('.'))) &&
      raw.length > read.length &&
      !raw.some(isObj) &&
      !read.some(isObj) &&
      read.every((x) => has(raw, x))
    )
      return [{ path, kind: 'extras', raw, read }]
  }
  return isDeepStrictEqual(raw, read) ? [] : [{ path, kind: 'altered', raw, read }]
}

/**
 * The paths a merge patch clears (`null`), so a write can tell a key the owner cleared from one that only looks missing because
 * this build could not read it. Lists of objects with unique ids (`threads`) are walked element by element, like `lossesOf`.
 */
export function clearedPaths(patch: unknown, path: Step[] = []): Step[][] {
  if (patch === null) return path.length > 0 ? [path] : []
  if (isObj(patch)) return Object.entries(patch).flatMap(([k, v]) => clearedPaths(v, [...path, k]))
  if (Array.isArray(patch) && byUniqueId(patch))
    return patch.flatMap((el) => clearedPaths(el, [...path, { id: idOf(el) as string }]))
  return []
}

/** True when the patch cleared this path or a parent of it: the owner decided that value, so a copy of the old one is not put back. */
export function isCleared(cleared: Step[][], path: Step[]): boolean {
  return cleared.some((c) => c.length <= path.length && c.every((s, i) => isDeepStrictEqual(s, path[i])))
}

/** Every dotted path inside a restored value, under `prefix` (array elements are not part of a path). */
export function pathsWithin(prefix: string[], value: unknown): string[] {
  const here = prefix.join('.')
  if (!isObj(value)) return [here]
  return [here, ...Object.entries(value).flatMap(([k, v]) => pathsWithin([...prefix, k], v))]
}

/**
 * An archived thread has no session of its own, so a `session` value this build could not read (and so could not clear) is not left
 * on it where a newer build would read it as live. It moves into the thread's `_unreadable` record, which nothing reads.
 */
export function quarantineArchivedSessions<T>(config: T): T {
  const out = structuredClone(config)
  const threads = isObj(out) && Array.isArray(out.threads) ? out.threads : []
  for (const t of threads) {
    if (!isObj(t) || t.archived !== true || !('session' in t) || t.session === undefined) continue
    const kept = { ...(isObj(t._unreadable) ? t._unreadable : {}) }
    const timestamp = Date.now()
    let counter = 0
    let key: string
    do {
      key = `session_${timestamp}_${counter++}`
    } while (Object.hasOwn(kept, key))
    kept[key] = t.session
    t._unreadable = kept
    delete t.session
  }
  return out
}

function child(node: unknown, s: Step): { found: boolean; value?: unknown } {
  if (typeof s === 'string') return isObj(node) && s in node ? { found: true, value: node[s] } : { found: false }
  const hit = Array.isArray(node) ? node.find((e) => idOf(e) === s.id) : undefined
  return hit === undefined ? { found: false } : { found: true, value: hit }
}

/** True when it put something back. */
function put(node: unknown, path: Step[], loss: Loss): boolean {
  const [head, ...rest] = path
  if (head === undefined) return false
  if (rest.length > 0) {
    const c = child(node, head)
    return c.found ? put(c.value, rest, loss) : false
  }
  if (typeof head !== 'string' || !isObj(node)) return false // the last step is always a key
  if (loss.kind === 'dropped') {
    if (node[head] !== undefined) return false
    node[head] = structuredClone(loss.raw)
    return true
  }
  const now = node[head]
  if (loss.kind === 'altered') {
    if (!(head in node) || !isDeepStrictEqual(now, loss.read)) return false
    node[head] = structuredClone(loss.raw)
    return true
  }
  if (!Array.isArray(now)) return false
  // raw order: what this write kept, the items the parse dropped, then what this write added
  const out: unknown[] = []
  for (const item of loss.raw) if (!has(loss.read, item) || has(now, item)) out.push(structuredClone(item))
  for (const item of now) if (!has(out, item)) out.push(item)
  if (isDeepStrictEqual(out, now)) return false
  node[head] = out
  return true
}

/**
 * `next` with the losses put back wherever the write did not touch them. A key or element the write removed stays removed.
 * `onRestore` hears the path (array elements as `*`) and the value of each kept value.
 */
export function restoreLosses<T>(
  next: T,
  losses: Loss[],
  opts: { skip?: (loss: Loss) => boolean; onRestore?: (path: string[], restored: unknown) => void } = {},
): T {
  const out = structuredClone(next)
  for (const l of losses)
    if (!opts.skip?.(l) && put(out, l.path, l))
      opts.onRestore?.(
        l.path.map((s) => (typeof s === 'string' ? s : '*')),
        l.raw,
      )
  return out
}

/**
 * Keys this project retired on purpose (permission_stepup, sessions_view and the Telegram mirror in 2026-11, the per-thread
 * session worktree flag). They are ours, not the owner's settings, so standing rule 1 does not keep them: a save removes them,
 * so a rollback to a build that still read them cannot switch them back on and the old chat id does not linger. `*` is every
 * array element. A key not listed here that a build does not know is a future one and stays.
 */
export const RETIRED_KEYS: readonly (readonly string[])[] = [
  ['permission_stepup'],
  ['sessions_view'],
  ['mirror'],
  ['threads', '*', 'mirror'],
  ['threads', '*', 'session_opts', 'worktree'],
]

export function stripRetired<T>(value: T): T {
  const out = structuredClone(value)
  const walk = (node: unknown, path: readonly string[]): void => {
    const [head, ...rest] = path
    if (head === undefined) return
    const targets = head === '*' ? (Array.isArray(node) ? node : []) : isObj(node) && head in node ? [node[head]] : []
    if (rest.length === 0) {
      if (isObj(node)) delete node[head]
      return
    }
    for (const t of targets) walk(t, rest)
  }
  for (const p of RETIRED_KEYS) walk(out, p)
  return out
}
