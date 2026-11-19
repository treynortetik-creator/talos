// Shared by the peer-inbox tests: a real relay on a fake clock, the Mac's signed setup calls, and a signed sender.
import { signStandard } from '@talos-app/integrations'
import { newPeerMessageId, type PeerMessageT } from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { bridgeFetch } from '../core/helpers.ts'

export const START = '2026-11-18T12:00:00.000Z'

export type Created = { conn_id: string; inbox_url: string; secret: string }

export type PeerWorld = {
  r: TestRelay
  clock: FakeClock
  /** A signed Mac call to the relay's peer routes. */
  mac(method: string, path: string, body?: unknown): Promise<Response>
  create(name: string, daily_cap?: number): Promise<Created>
  /** A PeerMessage as a sender would build it. */
  msg(over?: Partial<PeerMessageT>): PeerMessageT
  /** A correctly signed Standard Webhooks POST to the peer inbox. */
  send(
    c: { conn_id: string; secret: string },
    body: unknown,
    over?: { id?: string; tsS?: number; headers?: Record<string, string>; secret?: string; raw?: string },
  ): Promise<Response>
  /** The peer.message frames the relay has stored for the Mac, opened through the Mac's own socket is not needed: the types stored. */
  storedTypes(): string[]
  count(table: string): number
}

export async function peerWorld(env: Record<string, string> = {}): Promise<PeerWorld> {
  const clock = fakeClock(START)
  const r = await startTestRelay({ clock, env })
  const mac: PeerWorld['mac'] = (method, path, body) =>
    bridgeFetch(
      r,
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { 'content-type': 'application/json' },
    )
  const db = r.relay.services.db
  return {
    r,
    clock,
    mac,
    async create(name, daily_cap) {
      const res = await mac('POST', '/bridge/peers', { name, ...(daily_cap === undefined ? {} : { daily_cap }) })
      if (res.status !== 201) throw new Error(`create ${name}: ${res.status} ${await res.text()}`)
      return (await res.json()) as Created
    },
    msg: (over = {}) => ({
      v: 1,
      id: newPeerMessageId(),
      from: 'home',
      text: 'hello',
      chain: 0,
      from_peer_task: false,
      sent_at: new Date(clock.now()).toISOString(),
      ...over,
    }),
    send(c, body, over = {}) {
      const raw = over.raw ?? (typeof body === 'string' ? body : JSON.stringify(body))
      const id = over.id ?? (body as { id?: string }).id ?? newPeerMessageId()
      const headers = signStandard({
        secret: over.secret ?? c.secret,
        id,
        timestampS: over.tsS ?? Math.floor(clock.now() / 1000),
        body: raw,
      })
      return fetch(`${r.httpBase}/hook/peer/${c.conn_id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers, ...over.headers },
        body: raw,
      })
    },
    storedTypes: () =>
      (db.prepare('select distinct type from core_events order by type').all() as Array<{ type: string }>).map(
        (x) => x.type,
      ),
    count: (table) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n,
  }
}
