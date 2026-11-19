// peer_send: the checks, in the order the plan gives them. The loop guard and the chain come from what THIS bridge recorded.
import { afterEach, describe, expect, test } from 'bun:test'
import { PEER_CHAIN_MAX } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { deliver, type Install, install, link, linkBoth, memorySecrets, ownerSays, rowsOf, text } from './helpers.ts'

let a: Install | undefined
let b: Install | undefined
afterEach(async () => {
  await a?.stop()
  await b?.stop()
  a = b = undefined
})

const send = (h: Install, args: Record<string, unknown>) => h.bridge.callTool('peer_send', args)

async function pair(cap?: number) {
  a = await install({ to: () => b })
  b = await install({ to: () => a })
  await linkBoth(a, b, cap ? { cap } : {})
  return { a, b }
}

describe('peer_send: who and what', () => {
  test('a peer that is not configured, or has no secret, is refused with the command that links it', async () => {
    a = await install()
    const none = await send(a, { peer: 'work', text: 'hi' })
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('talos-app peer add work')
    b = await install()
    await link(a, b, { fromCalls: 'work', toCalls: 'home' })
    a.secrets.data.clear()
    const noSecret = await send(a, { peer: 'work', text: 'hi' })
    expect(noSecret.isError).toBe(true)
    expect(text(noSecret)).toContain('talos-app peer add work')
  })

  test('only main has the tool: not a thread session, not a headless job', async () => {
    const { toolsFor } = await import('../../src/tools/index.ts')
    const names = (o: Parameters<typeof toolsFor>[0]) => toolsFor(o).map((t) => t.name)
    expect(names({ scheduler: 'on' })).toContain('peer_send')
    expect(names({ scheduler: 'on', workerThread: 'trip' })).not.toContain('peer_send')
    expect(names({ scheduler: 'off', workerThread: 'trip' })).not.toContain('peer_send')
    const { AGENT_TOOLS } = await import('../../src/tools/table.ts')
    expect(AGENT_TOOLS.peer_send?.headless).toBe(false)
    expect(AGENT_TOOLS.peer_send?.worker).toBe(false)
    a = await install()
    const w = Object.create(a.bridge.ctx, { worker: { value: { thread: 'trip' } } })
    const { callTool } = await import('../../src/tools/index.ts')
    expect((await callTool(w, 'peer_send', { peer: 'work', text: 'x' })).isError).toBe(true)
  })

  test('an empty text, an over-long text and a control character are refused with the reason', async () => {
    const { a } = await pair()
    expect(text(await send(a, { peer: 'work', text: '   ' }))).toContain('empty')
    const long = await send(a, { peer: 'work', text: 'é'.repeat(4100) }) // 8200 bytes
    expect(long.isError).toBe(true)
    expect(text(long)).toContain('8192')
    const ctl = await send(a, { peer: 'work', text: 'a‮b' })
    expect(ctl.isError).toBe(true)
    expect(text(ctl)).toContain('control or bidi')
    expect(a.calls).toHaveLength(0)
  })

  test('a secret-looking string is redacted before it leaves, and the answer says so', async () => {
    const { a, b } = await pair()
    const r = await send(a, {
      peer: 'work',
      text: 'use API_TOKEN=abcd1234efgh5678ijkl9012 for the call',
      label: 'TASK',
    })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/1 item redacted/)
    await waitFor(() => b.peerNotes().length === 1, 4000, 'arrived')
    const got = b.peerNotes()[0]?.content ?? ''
    expect(got).not.toContain('abcd1234efgh5678ijkl9012')
    expect(got).toContain('[redacted]')
    expect(rowsOf(a).join('\n')).not.toContain('abcd1234efgh5678ijkl9012')
  })
})

describe('peer_send: the loop guard, from the bridge own records', () => {
  test('an in_reply_to that was never received is refused; so is one this Mac sent itself', async () => {
    const { a } = await pair()
    const never = await send(a, { peer: 'work', text: 'ok', in_reply_to: 'msg_01JBF3V7Q8K2M4N6P8R0S2T43X' })
    expect(never.isError).toBe(true)
    expect(text(never)).toContain('was not')
    const mine = await send(a, { peer: 'work', text: 'first', label: 'TASK' })
    const id = /\((msg_[0-9A-Z]{26})\)/.exec(text(mine))?.[1] as string
    expect(text(await send(a, { peer: 'work', text: 'again', in_reply_to: id }))).toContain('was not')
    expect((await send(a, { peer: 'work', text: 'x', in_reply_to: 'nonsense' })).isError).toBe(true)
  })

  test('a reply to a RESULT is refused', async () => {
    const { a } = await pair()
    const f = await deliver(a, 'work', { label: 'RESULT', text: 'done' })
    const r = await send(a, { peer: 'work', text: 'thanks!', in_reply_to: f.msg.id })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('a RESULT expects no reply')
  })

  test('the chain is the recorded chain plus one; past the limit it is refused', async () => {
    const { a } = await pair()
    const ok = await deliver(a, 'work', { chain: 2, label: 'TASK' })
    const r = await send(a, { peer: 'work', text: 'on it', in_reply_to: ok.msg.id, label: 'BLOCK' })
    expect(r.isError, text(r)).toBeFalsy()
    const row = a.bridge.ctx.store.db
      .query('SELECT chain FROM peer_messages WHERE dir = ? ORDER BY at DESC')
      .get('out') as { chain: number }
    expect(row.chain).toBe(3)
    const edge = await deliver(a, 'work', { chain: PEER_CHAIN_MAX, label: 'TASK' })
    const over = await send(a, { peer: 'work', text: 'once more', in_reply_to: edge.msg.id })
    expect(over.isError).toBe(true)
    expect(text(over)).toContain(`back and forth ${PEER_CHAIN_MAX} times; ask the owner`)
  })

  test('a reply to a message from one peer cannot be sent on to another peer', async () => {
    const { a, b } = await pair()
    const c = await install({ to: () => a })
    try {
      await link(a, c, { fromCalls: 'play', toCalls: 'house' })
      const f = await deliver(a, 'work', { label: 'TASK' })
      await ownerSays(a) // with the taint gone, the reply rule alone is what refuses it
      const r = await send(a, { peer: 'play', text: 'forwarding it', in_reply_to: f.msg.id })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('goes back to work only')
      expect(a.calls).toHaveLength(0)
      // to the peer it came from, it is fine
      expect((await send(a, { peer: 'work', text: 'on it', in_reply_to: f.msg.id })).isError).toBeFalsy()
    } finally {
      await c.stop()
    }
    void b
  })
})

describe('peer_send: the sender daily cap and the receiver 429', () => {
  test('the cap+1th message is refused, and not retried later', async () => {
    const { a } = await pair(2)
    expect((await send(a, { peer: 'work', text: 'one' })).isError).toBeFalsy()
    expect((await send(a, { peer: 'work', text: 'two' })).isError).toBeFalsy()
    const third = await send(a, { peer: 'work', text: 'three' })
    expect(third.isError).toBe(true)
    expect(text(third)).toContain('2 messages to work have gone today')
    await waitFor(() => a.calls.length === 2, 4000, 'two went')
    a.clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 200))
    expect(a.calls).toHaveLength(2)
  })

  test('the receiver 429 daily_cap leads to a retry after the next UTC midnight', async () => {
    const x = await install({ to: () => b })
    a = x
    const y = await install({ to: () => a, clock: x.clock })
    b = y
    await linkBoth(x, y)
    // the receiver's cap is 1: make it so
    y.relay.peers.rows[0]!.cap = 1
    x.clock.set(Date.UTC(2026, 10, 18, 22, 0, 0))
    await send(x, { peer: 'work', text: 'first' })
    await waitFor(() => x.calls.length === 1, 4000, 'first')
    await send(x, { peer: 'work', text: 'second' })
    await waitFor(() => x.calls.length === 2, 4000, 'second')
    expect(x.calls[1]?.status).toBe(429)
    x.clock.advance(3600_000) // 23:00: still the same UTC day
    await new Promise((r) => setTimeout(r, 200))
    expect(x.calls).toHaveLength(2)
    x.clock.advance(61 * 60_000) // past midnight
    await waitFor(() => x.calls.length === 3, 4000, 'the retry')
    expect(x.calls[2]?.status).toBe(200)
    expect(x.calls[2]?.id).toBe(x.calls[1]?.id)
    await waitFor(() => y.peerNotes().length === 2, 4000, 'both landed')
  })
})

void memorySecrets

describe('the hello', () => {
  test('a live bridge lists peer/1, and a bare context does not', async () => {
    const { bridgeFeatures } = await import('../../src/handshake.ts')
    a = await install()
    expect(bridgeFeatures(a.bridge.ctx)).toContain('peer/1')
    expect(bridgeFeatures({})).not.toContain('peer/1')
  })
})
