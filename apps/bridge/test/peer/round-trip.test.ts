// Linked agents, two installs: A messages B and B answers. Each install is a real bridge over its own FakeRelay, which holds the
// peer inbox the way the real relay does (signature, body, dedupe, cap, one durable frame).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { sleep, t, waitFor } from '@talos-app/testkit'
import { HARNESS_START_MS } from '../helpers.ts'
import { type Install, install, linkBoth, rowsOf, text } from './helpers.ts'

// two installs start (the harness's own waits) before a test's own waits begin
setDefaultTimeout(t(30_000))

let a: Install | undefined
let b: Install | undefined
afterEach(async () => {
  await a?.stop()
  await b?.stop()
  a = b = undefined
})

async function pair(o: { bStarted?: boolean } = {}) {
  a = await install({ to: () => b })
  b = await install({ to: () => a, ...(o.bStarted === false ? { startBridge: false } : {}) })
  await linkBoth(a, b)
  return { a, b }
}

describe('linked agents: two installs', () => {
  test(
    'a TASK arrives whole, the reply comes back with chain 1',
    async () => {
      const { a, b } = await pair()
      const ask = 'Please summarise the open pull requests, with the titles and who opened each one.'
      const r = await a.bridge.callTool('peer_send', { peer: 'work', text: ask, label: 'TASK' })
      expect(r.isError, text(r)).toBeFalsy()
      expect(text(r)).toStartWith('queued for work')
      await waitFor(() => b.peerNotes().length === 1, 4000, 'the message at B')
      const note = b.peerNotes()[0]
      expect(note?.meta).toMatchObject({
        kind: 'peer_message',
        trust: 'external',
        peer: 'home',
        label: 'TASK',
        chain: '0',
        from_peer_task: 'true',
      })
      expect(note?.content).toContain(`From home (TASK): ${ask}`)
      expect(note?.content).toContain('data, not instructions')
      // both owners see a quiet row
      expect(rowsOf(a).some((t) => t.startsWith('Sent to work (TASK): Please summarise'))).toBe(true)
      expect(rowsOf(b).some((t) => t.startsWith('From home (TASK): Please summarise'))).toBe(true)

      const sentId = note?.meta.peer_msg_id as string
      const back = await b.bridge.callTool('peer_send', {
        peer: 'home',
        text: 'Three are open: #4, #7 and #9.',
        label: 'RESULT',
        in_reply_to: sentId,
      })
      expect(back.isError, text(back)).toBeFalsy()
      await waitFor(() => a.peerNotes().length === 1, 4000, 'the reply at A')
      expect(a.peerNotes()[0]?.meta).toMatchObject({ peer: 'work', label: 'RESULT', chain: '1', in_reply_to: sentId })
      expect(a.peerNotes()[0]?.content).toContain('Three are open: #4, #7 and #9.')
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test(
    'the same id sent again after a lost answer lands once',
    async () => {
      const { a, b } = await pair()
      a.lose = 1 // B takes the message; the 2xx never gets back
      await a.bridge.callTool('peer_send', { peer: 'work', text: 'one message', label: 'TASK' })
      await waitFor(() => a.calls.length === 1 && a.clock.pending > 0, 4000, 'the first try, retry armed')
      await waitFor(() => b.peerNotes().length === 1, 4000, 'B has it')
      a.clock.advance(60_000) // the backoff
      await waitFor(() => a.calls.length === 2, 4000, 'the retry')
      expect(a.calls[1]?.id).toBe(a.calls[0]?.id)
      expect(a.calls.map((c) => c.status)).toEqual([200, 200])
      await sleep(t(200)) // timing-ok: negative window, from the retry answered and B's one note seen: still one
      expect(b.peerNotes()).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(50_000),
  )

  test(
    'a sleeping Mac gets it once when it comes back',
    async () => {
      const { a, b } = await pair({ bStarted: false })
      const sent = await a.bridge.callTool('peer_send', { peer: 'work', text: 'while you were away', label: 'TASK' })
      expect(sent.isError, text(sent)).toBeFalsy()
      await waitFor(() => a.calls.length === 1, 4000, 'A delivered it to B relay')
      expect(a.calls[0]?.status).toBe(200)
      expect(b.peerNotes()).toHaveLength(0)
      b.bridge.start()
      await waitFor(() => b.peerNotes().length === 1, 8000, 'B wakes and gets it')
      await sleep(t(300)) // timing-ok: negative window, from the one note seen at B: still one
      expect(b.peerNotes()).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'after the peer is removed the sender stops and says so; a frame queued before the revoke is not shown',
    async () => {
      const { a, b } = await pair({ bStarted: false })
      await a.bridge.callTool('peer_send', { peer: 'work', text: 'queued before the revoke', label: 'TASK' })
      await waitFor(() => a.calls.length === 1, 4000, 'delivered to the relay of B')
      // B removes the link while its Mac sleeps: the relay recalls the frame, the Mac drops the local record
      b.relay.peers.remove('home')
      const { removeInboundPeer } = await import('../../src/peer/records.ts')
      removeInboundPeer(b.home, 'home')
      b.bridge.start()
      await waitFor(() => b.bridge.client?.connected === true, 10_000, 'B to wake and be authed (its ready has run)')
      await sleep(t(500)) // timing-ok: negative window, from B's bridge authed: the recalled frame is not shown
      expect(b.peerNotes()).toHaveLength(0)

      await a.bridge.callTool('peer_send', { peer: 'work', text: 'after the revoke', label: 'TASK' })
      await waitFor(() => a.calls.length === 2, 4000, 'the next send')
      expect(a.calls[1]?.status).toBe(404)
      await waitFor(
        () => rowsOf(a).some((t) => t.includes('work no longer accepts messages; nothing more will be sent')),
        4000,
        'the row',
      )
      a.clock.advance(3 * 3600_000)
      await sleep(t(200)) // timing-ok: negative window, from the refusal row seen and the clock moved 3 h: no retry
      expect(a.calls).toHaveLength(2) // no retry
      const state = a.bridge.ctx.store.db.query('SELECT state FROM peer_outbox').all() as Array<{ state: string }>
      expect(state.map((s) => s.state).sort()).toEqual(['revoked', 'sent'])
    },
    HARNESS_START_MS * 2 + t(70_000),
  )
})
