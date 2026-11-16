// A thread session whose link to the main bridge (the hub socket) is down: a short drop says "try again shortly"; a link down
// since this session's bridge started, or for more than two minutes, says the session needs a restart instead, and since when.
// Real HubClient, a real unix socket that plays the hub, and an injected clock.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_DOWN_STALE_MS, HubClient } from '../src/hub/client.ts'
import { nullLogger } from '../src/log.ts'

const NONCE = 'test-nonce-0123456789abcdef'
const dirs: string[] = []
const clients: HubClient[] = []
const servers: Server[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function client(sockPath: string, clock: { t: number }) {
  const c = new HubClient({
    sockPath,
    threadId: 'trip',
    nonce: NONCE,
    log: nullLogger,
    reconnectMs: 60_000,
    now: () => clock.t,
  })
  clients.push(c)
  return c
}

const T0 = Date.parse('2026-11-12T20:00:00.000Z')

test('never reached since start: shortly at first, then "needs a restart" with when it started, never "try again shortly"', async () => {
  const d = mkdtempSync(join(tmpdir(), 'hubdown-'))
  dirs.push(d)
  const clock = { t: T0 }
  const c = client(join(d, 'nope.sock'), clock)
  // no connect() here: under Bun, connecting to a socket file that is not there throws at once (seen 2026-11-12); this test is about the words
  expect((await c.rpc('schedules_list', {})).text).toContain('try again shortly')
  expect(c.downSince).toBe(T0)
  clock.t = T0 + 20_000
  const r = await c.rpc('schedules_list', {})
  expect(r.ok).toBe(false)
  expect(r.text).not.toContain('try again shortly')
  expect(r.text).toContain('may be older than the main bridge')
  expect(r.text).toContain('needs a restart')
  expect(r.text).toContain("since this session's bridge started (2026-11-12T20:00:00Z)")
  expect(r.text).toContain('Nothing was done.')
})

test('a link that was up and dropped: shortly for two minutes, then a restart, naming when it went down', async () => {
  const d = mkdtempSync(join(tmpdir(), 'hubdown-'))
  dirs.push(d)
  const path = join(d, 'hub.sock')
  const socks: Socket[] = []
  const srv = createServer((s) => {
    socks.push(s)
    s.on('data', (b) => {
      if (String(b).includes('"hello"')) s.write(`${JSON.stringify({ t: 'welcome', thread_id: 'trip' })}\n`)
    })
  })
  servers.push(srv)
  await new Promise<void>((res) => srv.listen(path, () => res()))
  const clock = { t: T0 }
  const c = client(path, clock)
  expect(await c.connect()).toBe(true)
  expect(c.downSince).toBeUndefined()
  // up for an hour, then the hub goes away
  clock.t = T0 + 3600_000
  for (const s of socks) s.destroy()
  srv.close()
  await new Promise((r) => setTimeout(r, 50))
  expect(c.connected).toBe(false)
  expect(c.downSince).toBe(T0 + 3600_000)
  clock.t += HUB_DOWN_STALE_MS - 1000
  expect((await c.rpc('schedules_list', {})).text).toContain('try again shortly')
  clock.t += 2000
  const r = await c.rpc('schedule_propose', {})
  expect(r.text).not.toContain('try again shortly')
  expect(r.text).toContain('since 2026-11-12T21:00:00Z')
  expect(r.text).toContain('needs a restart')
})
