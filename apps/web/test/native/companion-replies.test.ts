// The Mac companion tells the page when he delivers replies himself (`companion_replies`). The page stays the authority:
// a reply it would have toasted is HELD while he delivers, reported in `companion_state.held`, dropped when he says he
// showed it (`shown`), and toasted (once, the newest) the moment he stops or the shell is lost. The page never loses one.
import { AgentConfig, WebToNative } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { attachShell } from '../../src/features/native/attach.ts'
import { buildCompanionFrame } from '../../src/features/native/companion.ts'
import { type Banner, watchForBanner } from '../../src/features/threads/bannerWatch.ts'
import { type ClientState, initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import {
  companionRepliesOn,
  heldReplies,
  holdReply,
  onHeldToast,
  repliesEpoch,
  resetCompanionRepliesForTest,
  setCompanionReplies,
  setViewingThread,
  subscribeCompanionReplies,
  viewingThread,
} from '../../src/lib/native/companionReplies.ts'
import type { Shell } from '../../src/lib/native/shell.ts'

const config = AgentConfig.parse(readyFixture.agent_config)
const other = config.threads.find((t) => t.notify === 'all' && !t.archived)?.id ?? config.threads[0]?.id ?? 'general'
const b = (threadId: string, n = 1): Banner => ({ key: `m${n}`, threadId, name: threadId, snippet: `news ${n}` })

beforeEach(() => resetCompanionRepliesForTest())
afterEach(() => resetCompanionRepliesForTest())

describe('the held list', () => {
  it('holds nothing while the companion is off, and says so (the banner shows as today)', () => {
    expect(companionRepliesOn()).toBe(false)
    expect(holdReply(b('ops'))).toBe(false)
    expect(heldReplies()).toEqual([])
  })

  it('holds a reply while he delivers: one entry per thread, a rising seq, the newest replacing the older', () => {
    setCompanionReplies(true)
    expect(holdReply(b('ops', 1))).toBe(true)
    expect(holdReply(b('work', 2))).toBe(true)
    const first = heldReplies()
    expect(first.map((h) => h.thread_id)).toEqual(['ops', 'work'])
    expect(holdReply(b('ops', 3))).toBe(true)
    const next = heldReplies()
    expect(next.map((h) => h.thread_id).sort()).toEqual(['ops', 'work'])
    const ops = (xs: typeof next) => xs.find((h) => h.thread_id === 'ops')?.seq ?? -1
    expect(ops(next)).toBeGreaterThan(ops(first))
  })

  it('drops what he says he showed, by thread and seq, and keeps a newer one for the same thread', () => {
    setCompanionReplies(true)
    holdReply(b('ops', 1))
    holdReply(b('work', 2))
    const seen = heldReplies()
    holdReply(b('ops', 3)) // newer than what he is about to say he showed
    setCompanionReplies(true, seen)
    expect(heldReplies().map((h) => h.thread_id)).toEqual(['ops'])
    expect(companionRepliesOn()).toBe(true)
  })

  it('drops the reply of a thread the owner opens (read where it landed)', () => {
    setCompanionReplies(true)
    holdReply(b('ops', 1))
    holdReply(b('work', 2))
    setViewingThread('ops')
    expect(heldReplies().map((h) => h.thread_id)).toEqual(['work'])
    expect(viewingThread()).toBe('ops')
  })

  it('tells subscribers whenever the list or the viewed thread changes', () => {
    let n = 0
    const off = subscribeCompanionReplies(() => n++)
    setCompanionReplies(true)
    holdReply(b('ops'))
    setViewingThread('work')
    setViewingThread('work') // no change
    off()
    holdReply(b('x'))
    expect(n).toBe(3)
  })
})

describe('the toast when he stops or the shell is lost', () => {
  it('shows one toast, the newest held reply, when the flag goes off', () => {
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    setCompanionReplies(true)
    holdReply(b('ops', 1))
    holdReply(b('work', 2))
    setCompanionReplies(false)
    expect(toasts.map((t) => t.snippet)).toEqual(['news 2'])
    expect(heldReplies()).toEqual([])
  })

  it('does not toast what he already showed, even when the same message turns him off', () => {
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    setCompanionReplies(true)
    holdReply(b('ops', 1))
    holdReply(b('work', 2))
    const seen = heldReplies()
    setCompanionReplies(false, [seen[1] as (typeof seen)[number]]) // he showed 'work' and stopped in one breath
    expect(toasts.map((t) => t.snippet)).toEqual(['news 1'])
  })

  it('toasts nothing when nothing is held, and nothing twice', () => {
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    setCompanionReplies(true)
    setCompanionReplies(false)
    expect(toasts).toEqual([])
    setCompanionReplies(true)
    holdReply(b('ops'))
    setCompanionReplies(false)
    setCompanionReplies(false)
    expect(toasts.length).toBe(1)
  })

  it('keeps a held reply for a toast sink that is not mounted yet, and shows it the moment one is', () => {
    setCompanionReplies(true)
    holdReply(b('ops', 7))
    setCompanionReplies(false)
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    expect(toasts.map((t) => t.snippet)).toEqual(['news 7'])
  })

  it('a reply that lands after the flag went off is an ordinary toast (the watcher shows it)', () => {
    setCompanionReplies(true)
    setCompanionReplies(false)
    expect(holdReply(b('ops'))).toBe(false)
  })
})

/** A real zustand store: the watcher is driven by the same unread-count rise the socket client makes. */
function world(onScreen: string | null = 'elsewhere') {
  const store = createStore<ClientState>(() => ({
    ...initialClientState(),
    config,
    threads: config.threads.map((t) => (t.id === other ? { ...t, notify: 'all' as const } : t)),
  }))
  const shown: Banner[] = []
  const off = watchForBanner(
    store,
    () => onScreen,
    (x) => shown.push(x),
    Date.now,
    holdReply,
  )
  let n = 0
  const land = () => {
    n += 1
    store.setState((s) => ({
      ...s,
      messages: {
        ...s.messages,
        [other]: [
          ...(s.messages[other] ?? []),
          {
            id: `m${n}`,
            thread_id: other,
            author: 'agent' as const,
            kind: 'text' as const,
            text: `news ${n}`,
            format: 'markdown' as const,
            attachments: [],
            via: 'app' as const,
            created_at: new Date().toISOString(),
          },
        ],
      },
      unread: { ...s.unread, [other]: (s.unread[other] ?? 0) + 1 },
    }))
  }
  return { shown, land, off }
}

describe('the jump banner and the held list', () => {
  it('shows no banner while he delivers; the reply is held instead', () => {
    const w = world()
    setCompanionReplies(true)
    w.land()
    expect(w.shown).toEqual([])
    expect(heldReplies().map((h) => h.thread_id)).toEqual([other])
    w.off()
  })

  it('shows the banner when the flag is off, and when no shell ever sent it', () => {
    const w = world()
    w.land()
    expect(w.shown.map((x) => x.snippet)).toEqual(['news 1'])
    expect(heldReplies()).toEqual([])
    w.off()
  })

  it('holds only what it would have toasted: not the thread on screen', () => {
    const w = world(other)
    setCompanionReplies(true)
    w.land()
    expect(heldReplies()).toEqual([])
    expect(w.shown).toEqual([])
    w.off()
  })

  it('brings the banner back for the next reply when the flag goes off mid-session', () => {
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    const w = world()
    setCompanionReplies(true)
    w.land()
    setCompanionReplies(false)
    expect(toasts.map((x) => x.snippet)).toEqual(['news 1'])
    w.land()
    expect(w.shown.map((x) => x.snippet)).toEqual(['news 2'])
    w.off()
  })

  it('a reply that lands while he is mid-flight on the flag is either held or shown, never neither', () => {
    const w = world()
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    setCompanionReplies(true)
    w.land() // held
    setCompanionReplies(false) // he stops before showing it: the toast
    w.land() // after: the watcher's banner
    setCompanionReplies(true)
    w.land() // held again
    expect(toasts.length + w.shown.length + heldReplies().length).toBe(3)
    w.off()
  })
})

describe('the frame carries what the page shows and holds', () => {
  const state = () => ({ ...initialClientState(), config })
  const input = (over: Record<string, unknown> = {}) => ({
    state: state(),
    signedIn: true,
    busy: false,
    failed: 0,
    lastReply: null,
    nowMs: Date.parse('2026-10-28T16:00:00.000Z'),
    ...over,
  })

  it('has viewing and held, valid on the wire', () => {
    const f = buildCompanionFrame(
      input({ viewing: 'general', held: [{ thread_id: 'ops', seq: 4 }] }) as Parameters<typeof buildCompanionFrame>[0],
    )
    expect(f.viewing).toBe('general')
    expect(f.held).toEqual([{ thread_id: 'ops', seq: 4 }])
    expect(WebToNative.safeParse(f).success).toBe(true)
  })

  it('echoes the epoch of the companion\'s "on" it applied, so a stale frame can be told from a fresh one', () => {
    expect(repliesEpoch()).toBeNull()
    setCompanionReplies(true, [], 4)
    expect(repliesEpoch()).toBe(4)
    const f = buildCompanionFrame(input({ repliesEpoch: repliesEpoch() }) as Parameters<typeof buildCompanionFrame>[0])
    expect(f.replies_epoch).toBe(4)
    expect(WebToNative.safeParse(f).success).toBe(true)
    setCompanionReplies(true, [], 5) // a new "on" (he turned off and on again)
    expect(repliesEpoch()).toBe(5)
    setCompanionReplies(false)
    expect(repliesEpoch()).toBeNull()
  })

  it('defaults to nothing on screen and nothing held, and signed out hides both', () => {
    const f = buildCompanionFrame(input() as Parameters<typeof buildCompanionFrame>[0])
    expect(f.viewing).toBeNull()
    expect(f.held).toEqual([])
    const out = buildCompanionFrame(
      input({ signedIn: false, viewing: 'general', held: [{ thread_id: 'ops', seq: 4 }] }) as Parameters<
        typeof buildCompanionFrame
      >[0],
    )
    expect(out.viewing).toBeNull()
    expect(out.held).toEqual([])
  })
})

describe('the companion_replies message', () => {
  function shellWorld() {
    const posted: unknown[] = []
    const bridge = createShellBridge({ post: (m) => posted.push(m) })
    const store = createStore(() => ({ ...initialClientState(), config, devicePinned: false, threads: config.threads }))
    const client = { store, onFrame: () => () => {} } as unknown as TalosClient
    const shell = { kind: 'desktop', bridge, platform: {} } as unknown as Shell
    useSession.setState({ status: 'anon' })
    const detach = attachShell(shell, client)
    return { bridge, detach }
  }

  it('turns the flag on and off, and the page takes it (receive answers true)', () => {
    const s = shellWorld()
    expect(s.bridge.receive({ type: 'companion_replies', on: true })).toBe(true)
    expect(companionRepliesOn()).toBe(true)
    expect(s.bridge.receive(JSON.stringify({ type: 'companion_replies', on: false }))).toBe(true)
    expect(companionRepliesOn()).toBe(false)
    s.detach()
  })

  it('carries the replies he showed, and the page drops them', () => {
    const s = shellWorld()
    s.bridge.receive({ type: 'companion_replies', on: true })
    holdReply(b('ops', 1))
    holdReply(b('work', 2))
    const seen = heldReplies()
    expect(s.bridge.receive({ type: 'companion_replies', on: true, shown: [seen[0]] })).toBe(true)
    expect(heldReplies().map((h) => h.thread_id)).toEqual(['work'])
    s.detach()
  })

  it('refuses anything that is not exactly a flag and a list of thread and seq', () => {
    const s = shellWorld()
    const bad = [
      { on: 'yes' },
      {},
      { on: true, extra: 1 },
      { on: true, shown: [{ thread_id: 'ops' }] },
      { on: true, shown: [{ thread_id: 'ops', seq: -1 }] },
      { on: true, shown: [{ thread_id: 'All', seq: 1 }] },
      { on: true, shown: 'ops' },
    ]
    for (const x of bad) expect(s.bridge.receive({ type: 'companion_replies', ...x }), JSON.stringify(x)).toBe(false)
    expect(companionRepliesOn()).toBe(false)
    s.detach()
  })

  it('a lost shell (detach) turns it off and toasts whatever is still held', () => {
    const toasts: Banner[] = []
    onHeldToast((t) => toasts.push(t))
    const s = shellWorld()
    s.bridge.receive({ type: 'companion_replies', on: true })
    holdReply(b('ops', 9))
    s.detach()
    expect(companionRepliesOn()).toBe(false)
    expect(toasts.map((t) => t.snippet)).toEqual(['news 9'])
  })
})
