import { AgentConfig } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { attachShell } from '../../src/features/native/attach.ts'
import { startNativeNotify } from '../../src/features/native/notify.ts'
import { useTerminalSessions } from '../../src/features/terminal/sessions.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import { installShell, type Shell } from '../../src/lib/native/shell.ts'

const config = AgentConfig.parse(readyFixture.agent_config)
const threadId = config.threads[0]?.id ?? 'general'

function setup(pinned: boolean) {
  const posted: Array<Record<string, unknown>> = []
  const bridge = createShellBridge({ post: (m) => posted.push(m as Record<string, unknown>) })
  const listeners: Record<string, Array<(f: unknown) => void>> = {}
  const sendMessage = vi.fn(async () => ({ clientMsgId: 'x', state: 'sent' as const }))
  const store = createStore(() => ({ ...initialClientState(), config, devicePinned: pinned, threads: config.threads }))
  const client = {
    store,
    sendMessage,
    onFrame(type: string, fn: (f: unknown) => void) {
      const list = listeners[type] ?? []
      listeners[type] = list
      list.push(fn)
      return () => {}
    },
  } as unknown as TalosClient
  const shell = { kind: 'desktop', bridge, platform: {} } as unknown as Shell
  return {
    posted,
    bridge,
    client,
    shell,
    sendMessage,
    emit: (t: string, f: unknown) => {
      for (const l of listeners[t] ?? []) l(f)
    },
  }
}

beforeEach(() => useSession.setState({ status: 'anon' }))

describe('attachShell', () => {
  it('sends ready with signed_in false, then badge and threads', () => {
    const t = setup(false)
    attachShell(t.shell, t.client)
    expect(t.posted[0]).toMatchObject({ type: 'ready', shell_api: 1, signed_in: false })
    expect(t.posted.some((m) => m.type === 'badge')).toBe(true)
    expect(t.posted.some((m) => m.type === 'threads')).toBe(true)
  })
  it('before sign-in and after sign-out the shell hears no threads and no badge', () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    const threadsMsgs = () => t.posted.filter((m) => m.type === 'threads')
    expect(threadsMsgs().at(-1)).toMatchObject({ items: [] }) // anon: cached store is not leaked
    useSession.setState({ status: 'authed' })
    expect(((threadsMsgs().at(-1)?.items as unknown[] | undefined) ?? []).length).toBeGreaterThan(0)
    useSession.setState({ status: 'anon' })
    expect(threadsMsgs().at(-1)).toMatchObject({ items: [] })
    expect(t.posted.filter((m) => m.type === 'badge').at(-1)).toMatchObject({ count: 0 })
  })
  it('ready is sent again with signed_in true once the Mac pins the device', () => {
    const t = setup(false)
    useSession.setState({ status: 'authed' })
    attachShell(t.shell, t.client)
    t.client.store.setState({ devicePinned: true })
    const readies = t.posted.filter((m) => m.type === 'ready')
    expect(readies.at(0)).toMatchObject({ signed_in: false })
    expect(readies.at(-1)).toMatchObject({ signed_in: true })
  })
  it('compose before sign-in sends nothing; after sign-in sends one message', async () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    expect(t.bridge.receive({ type: 'compose', thread_id: threadId, text: 'hello' })).toBe(false) // the shell is told no
    expect(t.sendMessage).not.toHaveBeenCalled()
    useSession.setState({ status: 'authed' })
    expect(await t.bridge.receive({ type: 'compose', thread_id: threadId, text: 'hello' })).toBe(true)
    expect(t.bridge.receive({ type: 'compose', thread_id: threadId, text: '   ' })).toBe(false)
    expect(t.sendMessage).toHaveBeenCalledTimes(1)
    expect(t.sendMessage).toHaveBeenCalledWith({ threadId, text: 'hello' })
  })
  it('compose answers true only after the message is signed and stored, and false when that fails', async () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    useSession.setState({ status: 'authed' })
    let stored: (v: { clientMsgId: string; state: 'sent' }) => void = () => {}
    t.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stored = resolve
        }),
    )
    const answer = t.bridge.receive({ type: 'compose', thread_id: threadId, text: 'hello' })
    expect(answer).toBeInstanceOf(Promise) // not true yet: the shell must wait
    let settled = false
    void (answer as Promise<boolean>).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    stored({ clientMsgId: 'x', state: 'sent' })
    expect(await answer).toBe(true)
    // The device key, the storage write or a sign-out race can make signing and storing throw: the shell is told no.
    t.sendMessage.mockRejectedValueOnce(new Error('storage write failed'))
    expect(await t.bridge.receive({ type: 'compose', thread_id: threadId, text: 'again' })).toBe(false)
  })
  it('the door an older Mac app uses stays a plain boolean; the door a newer one uses is a promise that waits for the save', async () => {
    // An older Mac app reads `receive` with evaluateJavaScript, which cannot take a promise: a promise there reads as
    // "not taken" for a message that was stored, and every retry would send it again.
    const scope: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage: () => {} } } },
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 TalosDesktop/1.0' },
    }
    scope.top = scope
    const shell = installShell(scope)
    if (!shell) throw new Error('the test shell did not install')
    const door = scope.talosNative as { receive(raw: string): unknown; receiveAck(raw: string): Promise<boolean> }
    const t = setup(true)
    attachShell(shell, t.client)
    const compose = JSON.stringify({ type: 'compose', thread_id: threadId, text: 'hello' })

    expect(door.receive(compose)).toBe(false) // not signed in: refused, same as before
    useSession.setState({ status: 'authed' })
    let stored: (v: { clientMsgId: string; state: 'sent' }) => void = () => {}
    t.sendMessage.mockImplementationOnce(() => new Promise((resolve) => (stored = resolve)))
    expect(door.receive(compose)).toBe(true) // a real boolean at once, while the save has not finished
    t.sendMessage.mockRejectedValueOnce(new Error('storage write failed'))
    expect(door.receive(compose)).toBe(true) // it never was an answer about the save
    stored({ clientMsgId: 'x', state: 'sent' })

    let pendingStore: (v: { clientMsgId: string; state: 'sent' }) => void = () => {}
    t.sendMessage.mockImplementationOnce(() => new Promise((resolve) => (pendingStore = resolve)))
    const ack = door.receiveAck(compose)
    expect(ack).toBeInstanceOf(Promise)
    let settled = false
    void ack.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    pendingStore({ clientMsgId: 'x', state: 'sent' })
    expect(await ack).toBe(true)
    t.sendMessage.mockRejectedValueOnce(new Error('storage write failed'))
    expect(await door.receiveAck(compose)).toBe(false)
    expect(await door.receiveAck('not json')).toBe(false)
  })
  it('enroll_code goes to /enroll#code; navigate stays in scope', () => {
    const t = setup(false)
    const goto = vi.fn()
    const nav = vi.fn()
    attachShell(t.shell, t.client, { goto, nav })
    t.bridge.receive({ type: 'enroll_code', code: '0123456789ABCDEFGHJKMNPQRS' })
    expect(goto).toHaveBeenCalledWith('/enroll#0123456789ABCDEFGHJKMNPQRS')
    t.bridge.receive({ type: 'navigate', path: '/t/general' })
    t.bridge.receive({ type: 'navigate', path: '//evil.com' })
    t.bridge.receive({ type: 'navigate', path: '/media/x' })
    expect(nav).toHaveBeenCalledTimes(1)
  })
})

describe('startNativeNotify', () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    type: 'reply',
    message: { author: 'agent', thread_id: threadId, text: 'SECRET BODY' },
    ...over,
  })
  it('hidden page + reply frame -> exactly one notify with fixed text only', () => {
    const t = setup(true)
    startNativeNotify(t.client, t.bridge, { background: () => true, now: () => new Date('2026-01-05T18:00:00Z') })
    t.emit('reply', reply())
    const n = t.posted.filter((m) => m.type === 'notify')
    expect(n).toHaveLength(1)
    expect(JSON.stringify(n[0])).not.toContain('SECRET')
  })
  it('visible page, silent reply, voice reply and owner message make none', () => {
    const t = setup(true)
    let bg = false
    startNativeNotify(t.client, t.bridge, { background: () => bg, now: () => new Date('2026-01-05T18:00:00Z') })
    t.emit('reply', reply())
    bg = true
    t.emit('reply', reply({ silent: true }))
    t.emit('reply', reply({ voice_delegation_id: 'v1' }))
    t.emit('reply', reply({ message: { author: 'owner', thread_id: threadId } }))
    expect(t.posted.filter((m) => m.type === 'notify')).toHaveLength(0)
  })
})

describe("the Terminal screen's messages from the Mac", () => {
  const sessions = {
    type: 'terminal_sessions',
    items: [{ id: 'main', name: 'Main', state: 'live', key: '1', panel: 'terminal', action: null, detail: '' }],
  }
  beforeEach(() => useTerminalSessions.getState().reset())

  it('the page says it can read the tab list, in ready', () => {
    const t = setup(false)
    attachShell(t.shell, t.client)
    expect(t.posted[0]).toMatchObject({ features: expect.arrayContaining(['terminal-tabs/1']) })
  })
  it('a list or a Resume answer before sign-in is refused and stored nowhere', () => {
    const t = setup(true) // device pinned, but no session
    attachShell(t.shell, t.client)
    expect(t.bridge.receive(sessions)).toBe(false)
    expect(t.bridge.receive({ type: 'terminal_resume_result', thread_id: 'p', outcome: 'asked' })).toBe(false)
    expect(useTerminalSessions.getState().items).toBeNull()
    expect(useTerminalSessions.getState().resume).toEqual({})
  })
  it('signed in, both are stored; signing out drops the thread names the list held', () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    useSession.setState({ status: 'authed' })
    expect(t.bridge.receive(sessions)).toBe(true)
    expect(t.bridge.receive({ type: 'terminal_resume_result', thread_id: 'p', outcome: 'park_pending' })).toBe(true)
    expect(useTerminalSessions.getState().items).toHaveLength(1)
    expect(useTerminalSessions.getState().resume.p).toMatchObject({ outcome: 'park_pending' })
    useSession.setState({ status: 'anon' })
    expect(useTerminalSessions.getState().items).toBeNull()
    expect(useTerminalSessions.getState().resume).toEqual({})
  })
  it('terminal_select is refused before sign-in and, signed in, asks the screen to switch tab', () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    expect(t.bridge.receive({ type: 'terminal_select', session: 'trip' })).toBe(false)
    expect(useTerminalSessions.getState().selectRequest).toBeNull()
    useSession.setState({ status: 'authed' })
    expect(t.bridge.receive({ type: 'terminal_select', session: 'trip' })).toBe(true)
    expect(useTerminalSessions.getState().selectRequest).toMatchObject({ id: 'trip' })
    expect(t.bridge.receive({ type: 'terminal_select', session: '=agent' })).toBe(false)
  })
  it('a list with one bad item still lands, minus that item', () => {
    const t = setup(true)
    attachShell(t.shell, t.client)
    useSession.setState({ status: 'authed' })
    expect(t.bridge.receive({ ...sessions, items: [...sessions.items, { id: '=agent', name: 'x' }] })).toBe(true)
    expect(useTerminalSessions.getState().items?.map((i) => i.id)).toEqual(['main'])
  })
})
