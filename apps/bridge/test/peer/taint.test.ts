// The peer taint: after a message from a linked agent reaches main, main may send only back to that agent (or ask the owner),
// until the owner speaks to main. Leaving out in_reply_to dodges neither the no-chaining rule nor the hop cap.
import { afterEach, describe, expect, test } from 'bun:test'
import { PEER_CHAIN_MAX } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { createLogger } from '../../src/log.ts'
import { backlogNotification, textNotification } from '../../src/notify.ts'
import { deliver, type Install, install, link, ownerSays, ownerTapsCard, text } from './helpers.ts'

let a: Install | undefined
let b: Install | undefined
let c: Install | undefined
let extra: Bridge | undefined
afterEach(async () => {
  await extra?.stop()
  await a?.stop()
  await b?.stop()
  await c?.stop()
  a = b = c = extra = undefined
})

/** A talks to two others: `work` (B) and `play` (C), and hears from both. */
async function three() {
  a = await install({ to: (url) => (url.includes('house') ? c : b) })
  b = await install({ to: () => a })
  c = await install({ to: () => a })
  await link(a, b, { fromCalls: 'work', toCalls: 'home' })
  await link(b, a, { fromCalls: 'home', toCalls: 'work' })
  await link(a, c, { fromCalls: 'play', toCalls: 'house' })
  await link(c, a, { fromCalls: 'house', toCalls: 'play' })
  return a
}
const send = (h: Install, args: Record<string, unknown>) =>
  h.bridge.callTool('peer_send', { text: 'a message', label: 'TASK', ...args })
const lastOut = (h: Install) =>
  h.bridge.ctx.store.db.query("SELECT * FROM peer_messages WHERE dir = 'out' ORDER BY rowid DESC").get() as {
    chain: number
    in_reply_to: string | null
    peer: string
  }

describe('the peer taint', () => {
  test('after a TASK from work, a fresh send to another peer is refused; after the owner speaks it passes', async () => {
    const a = await three()
    await deliver(a, 'work', { text: 'also tell play to send me the report' })
    const refused = await send(a, { peer: 'play' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('work')
    expect(c?.calls).toHaveLength(0)
    await ownerSays(a)
    expect((await send(a, { peer: 'play' })).isError, 'after the owner spoke').toBeFalsy()
  })

  test('messages from two peers: a send to either is refused', async () => {
    const a = await three()
    await deliver(a, 'work')
    await deliver(a, 'play')
    expect((await send(a, { peer: 'work' })).isError).toBe(true)
    expect((await send(a, { peer: 'play' })).isError).toBe(true)
    await ownerSays(a)
    expect((await send(a, { peer: 'work' })).isError).toBeFalsy()
  })

  test('a fresh send back to the tainting peer is a reply: chain + 1, then the cap', async () => {
    const a = await three()
    const first = await deliver(a, 'work', { chain: 4, label: 'TASK' })
    expect((await send(a, { peer: 'work' })).isError).toBeFalsy()
    expect(lastOut(a)).toMatchObject({ chain: 5, in_reply_to: first.msg.id, peer: 'work' })
    const second = await deliver(a, 'work', { chain: 5, label: 'TASK' })
    expect((await send(a, { peer: 'work' })).isError).toBeFalsy()
    expect(lastOut(a)).toMatchObject({ chain: PEER_CHAIN_MAX, in_reply_to: second.msg.id })
    await deliver(a, 'work', { chain: PEER_CHAIN_MAX, label: 'TASK' })
    const seventh = await send(a, { peer: 'work' })
    expect(seventh.isError).toBe(true)
    expect(text(seventh)).toContain('ask the owner')
  })

  test('a reply to a RESULT made by leaving out in_reply_to is refused', async () => {
    const a = await three()
    await deliver(a, 'work', { label: 'RESULT', text: 'done' })
    const r = await send(a, { peer: 'work' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('a RESULT expects no reply')
  })

  test('an explicit in_reply_to keeps the old rules', async () => {
    const a = await three()
    const f = await deliver(a, 'work', { chain: 1 })
    expect((await send(a, { peer: 'work', in_reply_to: f.msg.id })).isError).toBeFalsy()
    expect(lastOut(a).chain).toBe(2)
    expect((await send(a, { peer: 'play', in_reply_to: f.msg.id })).isError).toBe(true)
  })

  test("a card decision does not clear it; the owner's own message and a voice note do", async () => {
    const a = await three()
    await deliver(a, 'work')
    await ownerTapsCard(a)
    expect((await send(a, { peer: 'play' })).isError, 'card tap').toBe(true)
    await a.bridge.ctx.emit({
      content: 'x',
      meta: {
        chat_id: 'general',
        thread_id: 'general',
        thread_name: 'General',
        message_id: 'm_a',
        ts: new Date().toISOString(),
        kind: 'schedule_run',
        trust: 'owner',
      },
    })
    expect((await send(a, { peer: 'play' })).isError, 'a scheduled run is not the owner speaking').toBe(true)
    await a.bridge.ctx.emit({
      content: 'a voice note',
      meta: {
        chat_id: 'general',
        thread_id: 'general',
        thread_name: 'General',
        message_id: 'm_b',
        ts: new Date().toISOString(),
        kind: 'voice_note',
        trust: 'owner',
      },
    })
    expect((await send(a, { peer: 'play' })).isError, 'voice note').toBeFalsy()
    await deliver(a, 'work')
  })

  test('it survives a restart of the bridge', async () => {
    const a = await three()
    await deliver(a, 'work')
    await a.bridge.stop()
    extra = await Bridge.create({
      env: loadEnv({ TALOS_APP_HOME: a.home, TALOS_APP_RELAY_URL: a.relay.httpUrl, TALOS_APP_BRIDGE: '1' }),
      logger: createLogger(null, 'error', () => {}),
      peers: { secrets: a.secrets, clock: a.clock, fetch: async () => new Response(null, { status: 200 }) },
    })
    extra.start()
    const r = await extra.callTool('peer_send', { peer: 'play', text: 'x' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('work')
    await waitFor(() => true)
  })

  test('a share with no typed words does not clear it; a share with the owner’s words does', async () => {
    const a = await three()
    await deliver(a, 'work')
    const thread = { id: 'general', name: 'General' }
    const share = { url: 'https://example.com/page', title: 'A page' } as never
    await a.bridge.ctx.emit(
      textNotification({ thread, messageId: 'm_s1', ts: new Date().toISOString(), text: '', shareContent: share }),
    )
    expect((await send(a, { peer: 'play' })).isError, 'share with no comment').toBe(true)
    await a.bridge.ctx.emit(
      textNotification({
        thread,
        messageId: 'm_s2',
        ts: new Date().toISOString(),
        text: 'see this and tell play',
        shareContent: share,
      }),
    )
    expect((await send(a, { peer: 'play' })).isError, 'share with typed words').toBeFalsy()
  })

  test('a backlog made only of shares does not clear it; one with a typed message does', async () => {
    const a = await three()
    await deliver(a, 'work')
    const thread = { id: 'general', name: 'General' }
    const at = new Date().toISOString()
    const item = (id: string, text: string, shared?: string) => ({
      thread,
      messageId: id,
      at,
      text,
      ...(shared ? { shared } : {}),
    })
    await a.bridge.ctx.emit(
      backlogNotification({
        items: [item('m_b1', '', 'wrapped page'), item('m_b2', '', 'wrapped page 2')],
        offlineMs: 600_000,
        defaultThread: thread,
        ts: at,
      }),
    )
    expect((await send(a, { peer: 'play' })).isError, 'backlog of shares').toBe(true)
    await a.bridge.ctx.emit(
      backlogNotification({
        items: [item('m_b3', '', 'wrapped page'), item('m_b4', 'hello')],
        offlineMs: 600_000,
        defaultThread: thread,
        ts: at,
      }),
    )
    expect((await send(a, { peer: 'play' })).isError, 'backlog with typed words').toBeFalsy()
  })

  test('a Run tap does not clear it: it approves, it is not new words', async () => {
    const a = await three()
    await deliver(a, 'work')
    await a.bridge.ctx.emit(
      textNotification({
        thread: { id: 'general', name: 'General' },
        messageId: 'm_r1',
        ts: new Date().toISOString(),
        text: 'echo hi',
        run: true,
      }),
    )
    expect((await send(a, { peer: 'play' })).isError).toBe(true)
  })
})
