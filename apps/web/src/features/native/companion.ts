// The desktop companion's feed (DESKTOP-COMPANION-SPEC 7, feature `companion/1`). The page is the only side that holds the
// live state (cards, thread statuses, unread, the session), so it tells the Mac app in one small message, `companion_state`:
// counts and thread ids, never a name and never a word of a message. The words of a reply cross only on request
// (`companion_reply_request` -> `companion_reply`), after a click, as plain text capped at 500 characters.
//
// The pet is off by default and this file does nothing visible by itself: it only keeps `web.companionFeed` honest in the
// Mac app. An old Mac app drops the unknown message (`NativeBridge.dropped` goes up); an old page never sends it.
import {
  COMPANION_REPLY_MAX,
  COMPANION_ROWS_MAX,
  markdownToPlain,
  ownValue,
  ThreadId,
  type ThreadStatusT,
  type WebToNativeT,
} from '@talos-app/protocol'
import type { ClientState, TalosClient } from '../../lib/client.ts'
import type { ConnectionMeta } from '../../lib/connectionMeta.ts'
import type { ShellBridge } from '../../lib/native/bridge.ts'
import { freshStatus, freshStatuses } from '../../lib/threadStatus.ts'
import { useSession } from '../auth/session.ts'
import { awaitsOwner } from '../cards/logic.ts'
import { buildHome } from '../home/groups.ts'
import { getSessionController } from '../session/store.ts'

export type CompanionFrame = Extract<WebToNativeT, { type: 'companion_state' }>
export type CompanionReplyFrame = Extract<WebToNativeT, { type: 'companion_reply' }>
type Row = CompanionFrame['rows'][number]
type LastReply = NonNullable<CompanionFrame['last_reply']>

/** Edits are coalesced: a burst of store changes becomes one frame. `requestAnimationFrame` does not run in a hidden page. */
export const COMPANION_COALESCE_MS = 250
/** Cards expire with no store change, so the page re-counts on a timer, and always sends so the shell can tell a live page
 * from a silent one (the shell clears the feed after 90 s of silence). */
export const COMPANION_TICK_MS = 30_000

const MAX_COUNT = 99_999
const count = (n: number): number => Math.max(0, Math.min(MAX_COUNT, Math.trunc(n)))

export type CompanionInputs = {
  state: Pick<ClientState, 'connection' | 'presence' | 'config' | 'threads' | 'unread' | 'statuses' | 'cards' | 'inbox'>
  /** A session is signed in (the auth store, the same gate `threads` and `badge` use). */
  signedIn: boolean
  /** The Claude Code mod says a turn is running (the signal behind `useModBusy`). */
  busy: boolean
  failed: number
  lastReply: LastReply | null
  nowMs: number
}

/** The frame signed out: zeros, no rows. A cached store must not leak counts or ids to the shell. */
function signedOutFrame(connection: CompanionFrame['link']): CompanionFrame {
  return {
    type: 'companion_state',
    link: connection,
    mac_online: false,
    busy: false,
    needs: 0,
    working: 0,
    queued: 0,
    on_call: 0,
    unread: 0,
    failed: 0,
    rows: [],
    last_reply: null,
  }
}

/** Pure: the frame for a state. Row order is Home's (needs you, ready, working, queued), one row per thread, first wins. */
export function buildCompanionFrame(i: CompanionInputs): CompanionFrame {
  const s = i.state
  if (!i.signedIn) return signedOutFrame(s.connection)

  const statuses: ThreadStatusT[] = freshStatuses(s.statuses, i.nowMs)
  const inState = (state: ThreadStatusT['state']) => statuses.filter((t) => t.state === state).length
  const awaiting = s.cards.filter((c) => awaitsOwner(c, i.nowMs))
  const unread = s.threads
    .filter((t) => !t.archived && t.kind !== 'system')
    .reduce((n, t) => n + Math.max(0, ownValue(s.unread, t.id) ?? 0), 0)

  // `buildHome` with an empty snooze map: the local card snooze is screen state and must not reach the pet.
  const home = buildHome(
    { cards: s.cards, threads: s.threads, statuses: s.statuses, unread: s.unread, inbox: s.inbox },
    { nowMs: i.nowMs, timeZone: s.config?.timezone ?? 'UTC', localSnoozed: new Map() },
  )
  const candidates: Array<{ thread_id: string; state: Row['state'] }> = []
  const take = (state: Row['state'], groupId: 'needs_you' | 'ready' | 'working') => {
    for (const row of home.groups.find((g) => g.id === groupId)?.rows ?? []) {
      if (row.kind === 'card') candidates.push({ thread_id: row.card.thread_id, state })
      else if (row.kind === 'thread') candidates.push({ thread_id: row.thread.id, state })
    }
  }
  take('needs_you', 'needs_you')
  // A thread the agent marked `needs_you` with `set_status` (no card) shows the "Needs you" pill on its screen, but Home
  // has no group for it. The pet must not sit Idle while the app says Needs you, so it is a needs-you row, counted once.
  const cardThreads = new Set(awaiting.map((c) => c.thread_id))
  const flagged = s.threads.filter(
    (t) =>
      !t.archived &&
      t.kind !== 'system' &&
      freshStatus(ownValue(s.statuses, t.id), i.nowMs)?.state === 'needs_you' &&
      !cardThreads.has(t.id),
  )
  for (const t of flagged) candidates.push({ thread_id: t.id, state: 'needs_you' })
  take('ready', 'ready')
  take('working', 'working')
  for (const row of home.upNext)
    if (row.kind === 'thread') candidates.push({ thread_id: row.thread.id, state: 'queued' })
  // `buildHome` has no on-call group; the status itself says it (no source emits it today, so this is dormant).
  for (const t of statuses) if (t.state === 'on_call') candidates.push({ thread_id: t.thread_id, state: 'on_call' })

  const seen = new Set<string>()
  const rows: Row[] = []
  for (const c of candidates) {
    // One bad id degrades one row, never the frame (the bridge would drop the whole message).
    if (seen.has(c.thread_id) || !ThreadId.safeParse(c.thread_id).success) continue
    seen.add(c.thread_id)
    rows.push(c)
    if (rows.length === COMPANION_ROWS_MAX) break
  }

  return {
    type: 'companion_state',
    link: s.connection,
    mac_online: s.presence.bridge_online,
    busy: i.busy,
    needs: count(awaiting.length + flagged.length),
    working: count(inState('working')),
    queued: count(inState('queued')),
    on_call: count(inState('on_call')),
    unread: count(unread),
    failed: count(i.failed),
    rows,
    last_reply: i.lastReply,
  }
}

// Format and bidi controls hide text or reorder it; none of them belong in a line the shell shows. Escapes only, so
// no invisible character sits in this file's source. ZWNJ and ZWJ (U+200C, U+200D) are left out of this list on purpose:
// they are stripped by `JOINERS` below unless they sit between two visible characters, where they are real text (a ZWJ
// emoji, Persian). The rest: C0/C1 controls, zero-width and bidi marks, the Arabic letter mark, the soft hyphen, the Mongolian
// vowel separator, line/paragraph separators and bidi embeds, invisible math operators, the BOM, interlinear anchors, and the
// tag characters and supplementary variation selectors that can carry hidden text.
const HOSTILE_RANGES = [
  '\\u0000-\\u0008',
  '\\u000b-\\u001f',
  '\\u007f-\\u009f',
  '\\u00ad',
  '\\u061c',
  '\\u180e',
  '\\u200b',
  '\\u200e\\u200f',
  '\\u2028-\\u202e',
  '\\u2060-\\u206f',
  '\\ufeff',
  '\\ufff9-\\ufffb',
  '\\u{e0000}-\\u{e007f}',
  '\\u{e0100}-\\u{e01ef}',
]
const HOSTILE = new RegExp(`[${HOSTILE_RANGES.join('')}]`, 'gu')
const VISIBLE = '[\\p{L}\\p{M}\\p{N}\\p{Extended_Pictographic}\\u{1f3fb}-\\u{1f3ff}\\ufe0f]'
const JOINERS = new RegExp(`(?<!${VISIBLE})[\\u200c\\u200d]|[\\u200c\\u200d](?!${VISIBLE})`, 'gu')

/** Plain text of the newest agent message in one thread, capped. text null = nothing loaded, or the message has no text. */
export function lastReplyText(
  messages: ClientState['messages'],
  threadId: string,
): { text: string | null; truncated: boolean } {
  const list = ownValue(messages, threadId) ?? []
  let newest: (typeof list)[number] | undefined
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.author === 'agent') {
      newest = list[i]
      break
    }
  }
  const raw = newest?.text
  if (typeof raw !== 'string') return { text: null, truncated: false }
  const plain = markdownToPlain(raw).replace(HOSTILE, '').replace(JOINERS, '').trim()
  if (!plain) return { text: null, truncated: false }
  if (plain.length <= COMPANION_REPLY_MAX) return { text: plain, truncated: false }
  let cut = plain.slice(0, COMPANION_REPLY_MAX)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1) // never end on half a surrogate pair
  return { text: cut, truncated: true }
}

export type CompanionFeedHandle = {
  stop(): void
  /** Sends now if the frame changed (or always, with `force`). Tests use it; the page never needs to. */
  flush(force?: boolean): void
  /** Frames the bridge refused to send (an invalid frame returns false and logs nothing). */
  readonly dropped: number
  /** Frames the bridge took. */
  readonly sent: number
}

export function startCompanionFeed(
  client: TalosClient,
  bridge: ShellBridge,
  opts: { now?: () => number; coalesceMs?: number; tickMs?: number } = {},
): CompanionFeedHandle {
  const now = opts.now ?? Date.now
  // `client.meta` exists on the socket client only; the fake client and the iPhone shell have none, so failed is 0 there.
  const meta =
    'meta' in client
      ? (client as { meta: { getState(): ConnectionMeta; subscribe(fn: () => void): () => void } }).meta
      : null
  // The store only updates while the controller is started, and only mounted screens start it, so a hidden page on Home
  // would read false forever. The feed starts it and keeps the stop function.
  const ctl = getSessionController(client)
  const stopCtl = ctl.start()

  let lastReply: LastReply | null = null
  let lastKey = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let dropped = 0
  let sent = 0

  const modBusy = (): boolean => {
    const cs = ctl.store.getState()
    return cs.modOnline && cs.state?.busy === true
  }
  let busy = modBusy()

  const compute = (): CompanionFrame => {
    const signedIn = useSession.getState().status === 'authed'
    if (!signedIn) lastReply = null // a reply from the last session must not outlive it
    return buildCompanionFrame({
      state: client.store.getState(),
      signedIn,
      busy: modBusy(),
      failed: meta ? Object.keys(meta.getState().failed).length : 0,
      lastReply,
      nowMs: now(),
    })
  }
  const flush = (force = false) => {
    if (stopped) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const frame = compute()
    const key = JSON.stringify(frame)
    if (!force && key === lastKey) return
    if (bridge.send(frame)) {
      lastKey = key
      sent++
    } else {
      // Not remembered: the next change or tick tries again instead of believing it was sent.
      lastKey = ''
      dropped++
    }
  }
  const schedule = () => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, opts.coalesceMs ?? COMPANION_COALESCE_MS)
  }

  // The shell clears its feed whenever `ready` says the sign-in changed (and when the page reloads), and it remembers nothing
  // else. So a sign-in change forgets what was last sent: a sign-out and sign-in inside one coalescing window would
  // otherwise compute the very frame the shell just threw away, find it unchanged, and leave the pet blind until the tick.
  let pinned = client.store.getState().devicePinned
  const onStore = () => {
    const p = client.store.getState().devicePinned
    if (p !== pinned) {
      pinned = p
      lastKey = ''
    }
    schedule()
  }
  const onSession = () => {
    lastKey = ''
    // Not only inside compute(): a sign-out and sign-in inside one coalescing window never computes signed out.
    if (useSession.getState().status !== 'authed') lastReply = null
    schedule()
  }

  const offs = [
    client.store.subscribe(onStore),
    useSession.subscribe(onSession),
    // The controller's own 5 s tick patches `now` and notifies every subscriber; only a change of what the feed reads from it
    // (a turn running, the mod online) is worth a recompute, or a hidden page rebuilds Home 12 times a minute for nothing.
    ctl.store.subscribe(() => {
      const b = modBusy()
      if (b !== busy) {
        busy = b
        schedule()
      }
    }),
    ...(meta ? [meta.subscribe(schedule)] : []),
    client.onFrame('reply', (f) => {
      // The same filter as the native banner (notify.ts).
      if (f.silent || f.voice_delegation_id) return
      if (f.message.author !== 'agent') return
      const threadId = f.message.thread_id
      // Muted, or "Needs you only": notify.ts and the relay's push both keep a plain reply quiet for those, so the pet does too.
      const notify = client.store.getState().config?.threads.find((t) => t.id === threadId)?.notify
      if (notify === 'off' || notify === 'needs_you') return
      // `seq` is the relay's (`f.message.seq` is unset on the wire). No seq, no signal; it must rise.
      const seq = f.relay?.seq
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return
      if (lastReply && seq <= lastReply.seq) return
      lastReply = { thread_id: threadId, seq }
      schedule()
    }),
  ]
  const tick = setInterval(() => flush(true), opts.tickMs ?? COMPANION_TICK_MS)
  schedule()

  return {
    stop() {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      clearInterval(tick)
      for (const off of offs) off()
      stopCtl()
    },
    flush,
    get dropped() {
      return dropped
    },
    get sent() {
      return sent
    },
  }
}
