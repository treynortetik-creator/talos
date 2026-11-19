// The owner is told, silently, in the default thread when the bridge sees a linked agent or a device change: a `peers[]` entry added
// or removed in config.json, an inbox made or removed (peers-inbound.json), an approved device revoked (devices.json). It reports the
// fact, not who did it (the agent, a terminal, a hand edit all look the same), so the CLI posts nothing. Rows are fixed templates; the
// only text that is not ours is a validated peer name or a device label with its odd characters taken out. No url, conn id or secret.
// Compared against a snapshot kept in kv, so a restart re-posts nothing and a change made while the bridge was down is told once at the
// next start. Called from the bridge's poll (every 10 s, and at once on a change in the Talos home: bridge.ts noteTrust). What is told:
// a peer added, removed, or changed (its url's host, its url on the same host, or its daily cap), an inbox made, removed or replaced (a new conn id under the same
// name), an approved device revoked, and an AGENT run of `peer rotate` (it leaves a `secret_file` mark in the inbox record with a newer
// time). A `peer rotate` typed in a terminal changes nothing this bridge can see (the relay swaps the secret, the record stays the
// same), so it has no row.
import { createHash } from 'node:crypto'
import { PeerName } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from '../context.ts'
import { readInboundPeers } from './records.ts'

const KEY = 'peer_changes_seen'
type PeerSeen = { name: string; host: string; urlh?: string; cap: number; legacy?: true }
type InboxSeen = { name: string; conn_id: string; rotated?: number; legacy?: true }
type Seen = { peers: PeerSeen[]; inbox: InboxSeen[]; devices: Array<{ id: string; label: string }> }

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A short hash of the normalised full url: told apart without ever being shown (a path can carry the inbox's conn id). */
const urlHash = (url: string): string => {
  let norm = url
  try {
    norm = new URL(url).href
  } catch {
    // not a url: hashed as it is
  }
  return createHash('sha256').update(norm).digest('hex').slice(0, 12)
}

/** The host of a url as a plain lower-case hostname, or '' when it is not one (an IPv6 literal, an odd name): then no host is told. */
const hostOf = (url: string): string => {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return HOSTNAME.test(h) ? h : ''
  } catch {
    return ''
  }
}

/** A device label as stored, cut to plain words: letters, digits, spaces, apostrophes and hyphens, at most 60 characters. */
export const plainLabel = (name: string): string =>
  name
    .replace(/[^\p{L}\p{N} '-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim() || 'a device'

const byName = <T extends { name: string }>(xs: T[]): T[] =>
  [...new Map(xs.filter((x) => PeerName.safeParse(x.name).success).map((x) => [x.name, x])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

function read(ctx: BridgeContext, before: Seen | undefined): Seen {
  let devices = before?.devices ?? []
  try {
    // an unreadable devices.json is no news: nobody is told revoked until it can be read again
    if (!ctx.devices.isCorrupt())
      devices = ctx.devices
        .list()
        .filter((d) => !d.revoked_at)
        .map((d) => ({ id: d.id, label: plainLabel(d.name) }))
  } catch {
    // keep what was seen
  }
  return {
    peers: byName(
      ctx.config.config.peers.map((p) => ({
        name: p.name,
        host: hostOf(p.url),
        urlh: urlHash(p.url),
        cap: p.daily_cap,
      })),
    ),
    inbox: byName(
      readInboundPeers(ctx.env.home).map((p) => ({
        name: p.name,
        conn_id: p.conn_id,
        ...(p.secret_file?.kind === 'rotate' ? { rotated: p.secret_file.at } : {}),
      })),
    ),
    devices,
  }
}

const running = new WeakMap<object, Promise<unknown>>()

/**
 * Tells the owner what changed since the last look. Returns how many rows it posted. `post` is a seam for tests. Calls on the same
 * store run one after the other (the poll and the start can overlap), so a second call always reads the snapshot the first one saved
 * and a change is posted once. The snapshot moves ahead one row at a time, after that row's post succeeded: a row that failed to post
 * is still a difference at the next poll and is tried again, and a crash between a post and its save repeats that one row (at least
 * once, never lost).
 */
export function notePeerChanges(
  ctx: BridgeContext,
  post: (text: string) => Promise<unknown> = (t) => postSystemNotice(ctx, t, { silent: true }),
): Promise<number> {
  const prev = running.get(ctx.store) ?? Promise.resolve()
  const next = prev.then(() => look(ctx, post))
  running.set(
    ctx.store,
    next.catch(() => undefined),
  )
  return next
}

type Row = { text: string; apply: (s: Seen) => void }
const put = <T extends { name: string }>(xs: T[], x: T): T[] => [...xs.filter((y) => y.name !== x.name), x]
const drop = <T extends { name: string }>(xs: T[], name: string): T[] => xs.filter((y) => y.name !== name)

async function look(ctx: BridgeContext, post: (text: string) => Promise<unknown>): Promise<number> {
  if (ctx.mode !== 'live' || ctx.worker) return 0
  let before: Seen | undefined
  try {
    before = JSON.parse(ctx.store.kvGet(KEY) ?? 'null') as Seen | undefined
  } catch {
    before = undefined
  }
  const now = read(ctx, before ?? undefined)
  // An upgrade's first run (a snapshot with no earlier one) tells nothing: a change made between the upgrade and this first look is
  // not told. Accepted (R2): the alternative is a row for every peer, inbox and device that already existed.
  if (!before) {
    ctx.store.kvSet(KEY, JSON.stringify(now))
    return 0
  }
  // `cur` is the snapshot as far as it has been told. Devices approved since the last look are added to it at once (nothing is told
  // about an approval), so one that is revoked while posts keep failing still gets its row; and a peer whose old snapshot has no url
  // hash gets it from now, so a later change of its url on the same host is seen.
  const known = new Set((before.devices ?? []).map((d) => d.id))
  const cur: Seen = {
    peers: normalizePeers(before.peers).map((p) => {
      const n = now.peers.find((x) => x.name === p.name)
      return !p.legacy && p.urlh === undefined && n && n.host === p.host ? { ...p, urlh: n.urlh } : p
    }),
    inbox: normalizeInbox(before.inbox),
    devices: [...(before.devices ?? []), ...now.devices.filter((d) => !known.has(d.id))],
  }
  const rows: Row[] = []
  const oldPeers = new Map(cur.peers.map((p) => [p.name, p]))
  const newPeers = new Map(now.peers.map((p) => [p.name, p]))
  for (const [n, p] of newPeers) {
    const was = oldPeers.get(n)
    const apply = (s: Seen) => {
      s.peers = put(s.peers, p)
    }
    if (!was) rows.push({ text: `Linked peer added: ${n}`, apply })
    else if (
      !was.legacy &&
      (was.host !== p.host || was.cap !== p.cap || (was.urlh !== undefined && was.urlh !== p.urlh))
    ) {
      const where =
        was.host !== p.host
          ? p.host
            ? ` now sends to host ${p.host}`
            : ''
          : was.urlh !== undefined && was.urlh !== p.urlh && p.host
            ? ` now sends to a different inbox at host ${p.host}`
            : ''
      rows.push({ text: `Linked peer changed: ${n}${where}`, apply })
    }
  }
  for (const n of oldPeers.keys())
    if (!newPeers.has(n))
      rows.push({
        text: `Linked peer removed: ${n}`,
        apply: (s) => {
          s.peers = drop(s.peers, n)
        },
      })
  const oldInbox = new Map(cur.inbox.map((p) => [p.name, p]))
  const newInbox = new Map(now.inbox.map((p) => [p.name, p]))
  for (const [n, p] of newInbox) {
    const was = oldInbox.get(n)
    const apply = (s: Seen) => {
      s.inbox = put(s.inbox, p)
    }
    if (!was) rows.push({ text: `Peer inbox created: ${n}`, apply })
    else if (was.legacy) continue
    else if (was.conn_id !== p.conn_id) rows.push({ text: `Peer inbox replaced: ${n}`, apply })
    else if (p.rotated !== undefined && p.rotated > (was.rotated ?? Number.NEGATIVE_INFINITY))
      rows.push({ text: `Peer inbox secret replaced: ${n}`, apply })
  }
  for (const n of oldInbox.keys())
    if (!newInbox.has(n))
      rows.push({
        text: `Peer inbox removed: ${n}`,
        apply: (s) => {
          s.inbox = drop(s.inbox, n)
        },
      })
  const still = new Set(now.devices.map((d) => d.id))
  for (const d of cur.devices)
    if (!still.has(d.id))
      rows.push({
        text: `Device revoked: ${d.label}`,
        apply: (s) => {
          s.devices = s.devices.filter((x) => x.id !== d.id)
        },
      })
  let posted = 0
  let failed = false
  for (const row of rows) {
    try {
      await post(row.text)
    } catch (e) {
      failed = true
      ctx.log.warn('peer change row not posted', { error: (e as Error).message })
      continue
    }
    posted++
    row.apply(cur)
    ctx.store.kvSet(KEY, JSON.stringify(cur))
  }
  // all told (or nothing to tell): the snapshot is what is there now; else the partial one, with what needs no row filled in
  ctx.store.kvSet(KEY, JSON.stringify(failed ? cur : now))
  return posted
}

// snapshots from before the host, cap and conn id were kept were lists of names
const normalizePeers = (xs: unknown): PeerSeen[] =>
  (Array.isArray(xs) ? xs : []).map((x) =>
    typeof x === 'string' ? { name: x, host: '', cap: 0, legacy: true as const } : (x as PeerSeen),
  )
const normalizeInbox = (xs: unknown): InboxSeen[] =>
  (Array.isArray(xs) ? xs : []).map((x) =>
    typeof x === 'string' ? { name: x, conn_id: '', legacy: true as const } : (x as InboxSeen),
  )
