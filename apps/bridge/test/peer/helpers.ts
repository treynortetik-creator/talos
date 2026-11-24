// Linked agents tests: two installs are two real bridges, each with its own FakeRelay (which holds the peer inbox like the real
// relay: signature, body, id, dedupe, cap, one durable frame). The sender's network is a function that sends to the other
// install's FakeRelay, so what crosses is what a real sender would put on the wire.
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import type { Notification } from '../../src/notify.ts'
import { addInboundPeer, PEER_SECRET_SERVICE, peerSecretAccount } from '../../src/peer/records.ts'
import type { PeerFetch } from '../../src/peer/service.ts'
import { type Harness, startHarness } from '../helpers.ts'

/** A key store in memory: nothing here touches a real keychain. */
export function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  const k = (s: string, a: string) => `${s}\u0000${a}`
  return {
    backend: 'file_0600',
    strength: 'file',
    data,
    async get(s, a) {
      return data.get(k(s, a))
    },
    async set(s, a, v) {
      data.set(k(s, a), v)
    },
    async delete(s, a) {
      data.delete(k(s, a))
    },
    async has(s, a) {
      return data.has(k(s, a))
    },
  }
}

/** A fixed fake secret (whsec_ + base64 of 32 bytes): never a real one. */
export const FAKE_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

export type Install = Harness & {
  clock: FakeClock
  secrets: ReturnType<typeof memorySecrets>
  /** Every request this install's sender made: the message id and the status that came back. */
  calls: Array<{ id: string; status: number; ts: string }>
  /** When set, the sender gets this answer instead of the other install (a platform error page, say). */
  override: { status: number; body?: string } | null
  /** While above 0, the next answers are lost on the way back (the other install did take the message). */
  lose: number
  /** The notifications that reached the agent and are peer messages. */
  peerNotes(): Notification[]
}

/** The time both installs agree on: real now, so the relay's 5-minute window accepts what is signed. */
export const startOf = (): string => new Date().toISOString()

/**
 * One install. Its sender's network sends to `to()`'s own HTTP address, same path (what a real sender puts on the wire reaches the
 * other install's FakeRelay, which holds the peer inbox).
 */
export async function install(
  opts: { clock?: FakeClock; startBridge?: boolean; to?: (url: string) => Harness | undefined; cap?: number } = {},
): Promise<Install> {
  const clock = opts.clock ?? fakeClock(startOf())
  const secrets = memorySecrets()
  const calls: Install['calls'] = []
  const state = { lose: 0, override: null as Install['override'] }
  const fetchFn: PeerFetch = async (url, init) => {
    if (state.override) {
      const hd = init.headers as Record<string, string>
      calls.push({ id: String(hd['webhook-id']), status: state.override.status, ts: String(hd['webhook-timestamp']) })
      return new Response(state.override.body ?? null, { status: state.override.status })
    }
    const target = opts.to?.(url)
    if (!target) return new Response(null, { status: 503 })
    const res = await fetch(`${target.relay.httpUrl}${new URL(url).pathname}`, init as RequestInit)
    const hd = init.headers as Record<string, string>
    calls.push({ id: String(hd['webhook-id']), status: res.status, ts: String(hd['webhook-timestamp']) })
    if (state.lose > 0 && res.ok) {
      state.lose--
      throw new Error('connection lost')
    }
    return res
  }
  const h = await startHarness({
    relay: { now: () => clock.now() },
    ...(opts.startBridge === false ? { startBridge: false } : {}),
    bridge: { peers: { secrets, clock, fetch: fetchFn } },
  })
  return Object.defineProperties(
    Object.assign(h, { clock, secrets, calls, peerNotes: () => h.notes.filter((n) => n.meta.kind === 'peer_message') }),
    {
      override: {
        get: () => state.override,
        set: (v: Install['override']) => {
          state.override = v
        },
      },
      lose: {
        get: () => state.lose,
        set: (n: number) => {
          state.lose = n
        },
      },
    },
  ) as Install
}

/**
 * `from` messages `to`: `from` calls the other install `fromCalls` (a configured peer: url + secret), and `to` keeps an inbox
 * for it under `toCalls` (the connection name its frames carry). The inbox is made the way `peer create` makes it.
 */
export async function link(
  from: Install,
  to: Install,
  names: { fromCalls: string; toCalls: string },
  o: { cap?: number } = {},
): Promise<{ conn: string; url: string }> {
  const made = to.relay.peers.create({ name: names.toCalls }).body as {
    conn_id: string
    inbox_url: string
    secret: string
  }
  addInboundPeer(to.home, { name: names.toCalls, conn_id: made.conn_id })
  const url = `https://${names.toCalls}-inbox.example.com/hook/peer/${made.conn_id}`
  from.bridge.ctx.config.update((c) => ({
    ...c,
    peers: [
      ...c.peers.filter((p) => p.name !== names.fromCalls),
      { name: names.fromCalls, url, daily_cap: o.cap ?? 50 },
    ],
  }))
  await from.secrets.set(PEER_SECRET_SERVICE, peerSecretAccount(names.fromCalls), made.secret)
  return { conn: made.conn_id, url }
}

/** Both directions: A calls B `work` and B calls A `home`. */
export async function linkBoth(a: Install, b: Install, o: { cap?: number } = {}) {
  return {
    ab: await link(a, b, { fromCalls: 'work', toCalls: 'home' }, o),
    ba: await link(b, a, { fromCalls: 'home', toCalls: 'work' }, o),
  }
}

export const text = (r: { content: Array<{ text?: string }> }): string => r.content[0]?.text ?? ''
export const homeOf = (h: Harness): string => join(h.home)

/** The system rows of a thread, newest last. */
export const rowsOf = (h: Harness, thread = 'general'): string[] =>
  h.bridge.ctx.store
    .page({ thread_id: thread, limit: 100 })
    .messages.filter((m) => m.author === 'system')
    .map((m) => m.text ?? '')

import { newPeerMessageId, newUlid } from '@talos-app/protocol'
import { readInboundPeers } from '../../src/peer/records.ts'

/** A `peer.message` frame the relay hands `to` for its inbox `name` (as the relay builds it after its own checks). */
export function inboundFrame(
  to: Harness,
  name: string,
  over: Record<string, unknown> = {},
  connId?: string,
): Record<string, unknown> {
  const conn = connId ?? readInboundPeers(to.home).find((p) => p.name === name)?.conn_id ?? 'cn_unknownunknownunknown'
  const now = new Date().toISOString()
  return {
    v: 1,
    type: 'peer.message',
    id: newUlid(),
    ts: now,
    conn_id: conn,
    peer: name,
    msg: {
      v: 1,
      id: newPeerMessageId(),
      from: 'linked',
      label: 'TASK',
      text: 'hello there',
      chain: 0,
      from_peer_task: false,
      sent_at: now,
      ...over,
    },
    received_at: now,
  }
}

/** Hands `to` a message from its inbox `name` and waits for it to be handled (the relay sees `consumed`). */
export async function deliver(to: Harness, name: string, over: Record<string, unknown> = {}, connId?: string) {
  const f = to.relay.sendToBridge(inboundFrame(to, name, over, connId))
  await to.relay.expectFrame('ack', (x) => x.ref === f.id && x.stage === 'consumed', { direction: 'from_bridge' })
  return f as Record<string, unknown> & { id: string; msg: { id: string } }
}

import { newUlid as ulid } from '@talos-app/protocol'
import { textNotification } from '../../src/notify.ts'

/** The owner types a message to main: it reaches the agent as a trust=owner note. */
export async function ownerSays(h: Harness, words = 'ok, go ahead'): Promise<void> {
  await h.bridge.ctx.emit(
    textNotification({
      thread: { id: 'general', name: 'General' },
      messageId: `m_${ulid()}`,
      ts: new Date().toISOString(),
      text: words,
    }),
  )
}

/** The owner's tap on a card, as the agent hears it: trust=owner, kind=card_action. */
export async function ownerTapsCard(h: Harness): Promise<void> {
  await h.bridge.ctx.emit({
    content: 'The owner approved the card.',
    meta: {
      chat_id: 'general',
      thread_id: 'general',
      thread_name: 'General',
      message_id: `m_${ulid()}`,
      ts: new Date().toISOString(),
      kind: 'card_action',
      trust: 'owner',
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    },
  })
}
